# EDW on AWS

EDW (eGPT in one container) on one EC2 instance in EduWeb's account (331665579468, us-east-1, WSL profile `eduweb`). Plain EC2 + Docker. Access is through SSM only: no key pair, no inbound port.

The move to ECS on EC2 is in [ECS on EC2](#ecs-on-ec2-ecs) below. After the cutover, `ecs/ecs-deploy.sh` replaces `run.sh`.

- Every script is a **dry run** that prints what it would do; `--apply` does it.
- Everything created is tagged `Project=egpt-edw` (and `Name=edw-*`) and found again by that tag. Untagged resources are never touched. The account runs EduWeb production, and one of its instances is named `edw-Sun…`, so a Name alone never identifies ours.
- Each `.sh` has a `.cmd` beside it that runs it in WSL (Ubuntu-22.04) with the same arguments, e.g. `provision.cmd --apply`.

## Deployments (`deployments/*.env`)

The scripts serve more than one deployment. Each is a file in `deployments/`, sourced by `lib.sh` (bash syntax), and picked with `--deploy <name>` on any script or `.cmd`. Without the flag it is `edw`, so every command below works unchanged.

- `edw.env`: EDW, EduWeb's account, with the values the scripts used to hold.
- `nu.env`: NU, an independent node in the personal account 480854905773 ([plan](../../plans/2611020936-NU-NODE.md)).

Each file sets:
- the account: any other is refused, so a profile pointing at the wrong account stops the script;
- the profile, the region, and the `Project` tag. Nothing without that tag is touched;
- the name prefix `N`, which names:
  - the cluster, service, family and container `$N`;
  - `$N-ecs-lt`, `$N-ecs-asg`, `$N-ecs-role`, `$N-ecs-profile`, `$N-ecs-node`;
  - the data volume and its instance attribute, `$N-data`;
  - `$N-vpc`, `$N-igw`, `$N-public`, `$N-rt`, `$N-sg`;
  - the image tag, `egpt:$N`;
- the CIDRs, the instance types, the on-demand default, the data volume's size, swap, the memory reservation and `EGPT_BEEPER`.

What differs between deployments is a switch, not a branch on the name:

| Key | EDW | NU | Effect |
|---|---|---|---|
| `LEGACY_NODE` | `edw-node` | empty | The plain-EC2 host. With one: ecs-provision.sh reuses provision.sh's network and volume, ecs-cutover.sh migrates from it, and provision.sh, migrate.sh and run.sh run. Without one: ecs-provision.sh makes the network and the volume, ecs-cutover.sh is the first start, and the plain-EC2 scripts refuse. |
| `DATA_INIT` | empty | `format` | `format`: ecs-provision.sh tags the data volume it creates `DataInit=pending`; at boot the instance formats it only if it has no filesystem and that tag, creates `egpt-home`, and tags it `DataInit=done` (`$N-data-attach` allows that one tag). Anything else is never formatted. A new encrypted volume reads as random bytes, not zeros, so the tag is the only sign it is blank. Empty: never formats, and requires `egpt-home/config/config.yaml`. |
| `BUCKET` | `egpt-edw-transfer-…` | empty | The transfer bucket; the ECS role gets `$N-transfer` on it. |
| `OFICINA_TUNNEL` | 1 | 0 | The oficina-tunnel sidecar. |
| `ZONE`, `DNS_NAME`, `ZONE_VPC` | `egpt.internal`, … | empty | The private zone and the A record the instance sets at boot (`$N-dns`). |
| `ECR_UNTAGGED` | 1 | 0 | EduWeb's ECR `egpt` was made by hand, untagged. Anywhere else, build-push.sh refuses an existing repo without the deployment's tag. |
| `SSH_PORT` | empty | 2222 | [SSH into the container](#ssh-into-the-container-ssh_port-nu): sshd as egpt on that port (`EGPT_SSH_PORT` in the task definition), tcp `SSH_PORT` from anywhere in `$N-sg`, and the Elastic IP `$N-ip`, which the instance associates at boot (`$N-address`). Empty: none of these. |

### NU, the first time

1. **`build-push.sh --deploy nu --apply`**, from a plain checkout in WSL. It creates ECR `egpt` tagged `Project=egpt-nu` and pushes `egpt:<sha>` and `egpt:nu`.
2. **`ecs/ecs-provision.sh --deploy nu --apply`** creates, in order:
   - the VPC 10.90.0.0/16 with its gateway, subnet, routes, and `nu-sg`, whose only inbound rule is tcp 2222 (SSH);
   - `nu-data`, an empty, encrypted 30 GB gp3 volume;
   - the Elastic IP `nu-ip`;
   - the role, the profile, the cluster, the launch template, the ASG (on-demand t3a.small/t3.small, at 0), the task definition and the service (at 0).
3. **`ecs/ecs-cutover.sh --deploy nu --apply`**. With no plain-EC2 node, it scales the ASG to 1, waits for `nu-data` to be mounted, and sets the service to 1.
   - At its first boot the instance formats the blank `nu-data` and creates `egpt-home`.
   - The entrypoint then seeds `config/config.yaml` and `secrets/vnc.password`.
   - `--rollback` is refused, because there is nothing to roll back to.
4. Then plan phase 3: the config, being N, the claude token, and the Beeper sign-ins over VNC.

Notes:
- When `EGPT_BEEPER` is not `off`, each Beeper profile lives on the data volume, so sign-ins survive a new task.
  - The first account's `~/.config/BeeperTexts` is mounted from `/srv/egpt/egpt-beeper`, and each other account's `~/.config/BeeperTexts-<name>` from `/srv/egpt/egpt-beeper-<name>`.
  - The instance creates these dirs owned by 1000:1000 at every boot, with the others.
  - See [Two Beeper accounts](#two-beeper-accounts-in-one-container-nu).
- `TYPES` in `nu.env` is the operator's t3a.small. Two Beepers took ~0.9 GB before sign-in; to move to medium, change `TYPES` and re-run ecs-provision.sh, then follow [Resizing in place](#resizing-edw-in-place-learned-2026-10-30) for the running instance.
- Teardown is by tag, `Project=egpt-nu`, as for EDW.

## Order

1. **`build-push.sh --apply`** builds the image from the checkout it sits in, tags it `egpt:<sha>` and `egpt:edw`, and pushes both to ECR `egpt`. The image is ~3.2 GB (~1.3 GB compressed); it carries no whisper model, since models live on the data volume.
2. **`provision.sh [--type t3a.medium] --apply`** creates the VPC, subnet, internet gateway, route table, a security group with no inbound rules, the instance role, a 30 GB data volume and the instance, then prints the instance id, AZ and IPs. The first boot (a few minutes; log in `/var/log/cloud-init-output.log`) installs Docker, adds a 4 GB swap file, and mounts the data volume at `/srv/egpt`.
3. **`migrate.sh --apply`** checks that the instance's targets are empty, then stops the local `edw` (restart=no). It tars egpt-home and egpt-claude, moves them through a private encrypted bucket into `/srv/egpt`, and deletes the S3 objects. Local volumes are not touched.
4. **`run.sh --apply`** (from WSL) copies itself to the instance over SSM and starts `edw` from `egpt:edw` with `EGPT_BRANCH=edw` and `EGPT_BEEPER=off`. Run it again after each build-push to replace the container (stop, rm, run). `--tag <sha>` runs an older build.
5. **Verify on Telegram:** lark and ED answer.
6. **Later**, once AWS has proven itself, delete the local container: `docker rm edw` (and its volumes when sure).

## One poller

A bot token allows one long-polling client. A second EDW (laptop + AWS) gets 409 Conflict, and the beings answer twice. That is why migrate.sh stops the local container before copying anything.

To fall back, first stop AWS (`sudo docker stop edw` on the instance), then on the laptop run `docker update --restart unless-stopped edw && docker start edw`. Anything EDW wrote on AWS after the cutover stays there.

## Getting in

- **Shell:** `aws ssm start-session --target <instance-id>`, then `sudo -i`. This needs the Session Manager plugin in WSL (not installed today): https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-debian-and-ubuntu.html
  - On the instance: `docker logs -f edw`; `bash /srv/egpt/run.sh` (dry run there).
- **Without the plugin:** `aws ssm send-command` works, and it is what run.sh and migrate.sh use.
- **VNC:** the container publishes 5900/6080 on the instance's 127.0.0.1 only. Forward noVNC to the laptop (plugin needed):

  ```
  aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession \
    --parameters '{"portNumber":["6080"],"localPortNumber":["16080"]}'
  ```

  Then open http://localhost:16080/vnc.html. The password is in `/srv/egpt/vnc.env` (`sudo cat` it in a session).

## Resize

The state lives on the data volume, so a resize is stop, change, start:

```
aws ec2 stop-instances --instance-ids <id> && aws ec2 wait instance-stopped --instance-ids <id>
aws ec2 modify-instance-attribute --instance-id <id> --instance-type '{"Value":"t3a.large"}'
aws ec2 start-instances --instance-ids <id>
```

The public IP changes (nothing depends on it), and Docker restarts `edw` on boot.

## Costs (on-demand, measured 10-23)

| Type | Per month | Fit |
|---|---|---|
| t3.small (2 GB) | ~$15 | too small: whisper large-v3 needs 3–4 GB |
| **t3a.medium** (4 GB), default | ~$27 | runs large-v3; the 4 GB swap is a safety net |
| t3a.large (8 GB) | ~$55 | if voice notes struggle |

- gp3 storage costs $0.08/GB-mo: 30 GB root + 30 GB data ≈ $4.80/mo.
- Not in the 10-23 numbers:
  - the public IPv4 address, $0.005/h (≈ $3.65/mo);
  - ECR storage, $0.10/GB-mo (old tags accumulate);
  - t3/t3a run with unlimited CPU credits by default, so CPU sustained above the baseline is billed.

## ECS on EC2 (`ecs/`)

ECS runs EDW's container, so nobody manages the instance by hand. There is one container instance, from an Auto Scaling group (min = max = 1) in `edw-public` (us-east-1a, the data volume's AZ). By default it is Spot, from the t3a.small and t3.small pools. When Spot takes the instance back, the ASG launches another one, which re-attaches `edw-data`, and ECS starts the task there. That is a few minutes of downtime, mostly the ~1.3 GB image pull.

The rules are the same as above: dry run unless `--apply`, everything tagged `Project=egpt-edw`, and a `.cmd` beside each script.

### Order

1. **`build-push.sh --apply`**, once. The entrypoint now reads the VNC password from `secrets/vnc.password` (made once, 0600) when `VNC_PASSWORD` is unset, so the task definition carries no password. The image in ECR predates this change, so under ECS VNC stays off until the rebuild.
2. **`ecs/ecs-provision.sh [--on-demand] --apply`** creates:
   - the role `edw-ecs-role` with its profile `edw-ecs-profile`. It has edw-instance-role's policies (SSM, ECR read, edw-transfer), plus AmazonEC2ContainerServiceforEC2Role, plus `edw-data-attach`: AttachVolume only on the volume tagged `Project=egpt-edw` + `Name=edw-data` and on our tagged instances, and DescribeVolumes, plus `edw-dns`: UPSERT of the A record `edw.egpt.internal` in our zone, nothing else;
   - the Route 53 private zone `egpt.internal`, found by name + tag, associated with EduWeb's production VPC (`ZONE_VPC` in `ecs-lib.sh`), where Portales-new proxies the chatbox to `edw.egpt.internal:8095`;
   - the cluster `edw`;
   - the launch template `edw-ecs-lt`: the ECS-optimized Amazon Linux 2023 AMI (resolved when the script runs), IMDSv2 with hop limit 1, an encrypted 30 GB gp3 root, edw-sg, a public IPv4, and the user data below;
   - the ASG `edw-ecs-asg`, at 0;
   - the task definition `edw`, its first revision at egpt:edw's digest;
   - the service `edw`, at 0, with min 0 / max 100 % and a circuit breaker that rolls back.

   Re-run it to move to a newer AMI (a new template version, used by the next instance) or to switch to `--on-demand`.
3. **`ecs/ecs-cutover.sh --apply`** does, in order:
   - stops `edw` on edw-node and sets it to restart=no;
   - stops edw-node, which is kept, not terminated;
   - detaches edw-data and scales the ASG to 1;
   - waits for the new instance to mount edw-data (ECS attribute `edw-data=mounted`);
   - sets the service to 1 and waits for it to settle.
4. **Verify on Telegram.**
5. **Later**, terminate edw-node: `aws ec2 terminate-instances --instance-ids i-02476c2d8b9173596`. Its root volume goes with it; edw-data stays. Until then, `ecs/ecs-cutover.sh --rollback --apply` reverses the cutover: service to 0, ASG to 0, edw-data back on edw-node, then edw-node and its `edw` started.

### Deploy

Run `build-push.sh --apply`, then `ecs/ecs-deploy.sh --apply`. It registers a task-definition revision pinned to the image's current digest and points the service at it. The old task stops before the new one starts, so there is one Telegram poller at a time.
- `--tag <sha>` deploys an older build.
- `--restart` replaces the task when nothing changed.
- If the new task cannot start, the circuit breaker rolls back, and the script says so.

### The instance's first boot

The user data logs to `/var/log/cloud-init-output.log`. In order, it:
- writes the ECS config: `ECS_CLUSTER=edw`, task IAM roles off, Spot draining on;
- adds a **metadata guard**: an iptables rule that lets only root reach 169.254.169.254.
  - Why: the task uses host networking, so hop limit 1 no longer keeps the container away from the role's credentials. Those credentials hold AttachVolume, the ECS agent's rights, and SSM GetParameter on the whole account.
  - The ECS and SSM agents run as root. The container runs as egpt (uid 1000) and the being boxes as uid 200000 and up.
- sets up Docker log rotation and a 4 GB swap file;
- installs `edw-dns.service`, which at every boot UPSERTs `edw.egpt.internal` A to the instance's private IP (IMDSv2 `local-ipv4`), retrying for 3 min. Log: `journalctl -u edw-dns`, also on the console. If it fails, the record keeps its old address and the rest of the setup goes on;
- attaches edw-data, waiting up to 20 min while a previous instance lets go of it, and mounts it at `/srv/egpt` by UUID. It never formats the volume, and it requires `egpt-home/config/config.yaml` to be there;
- only then sets the attribute `edw-data=mounted`, which the task requires, and makes the ECS agent require the mount on later boots.

If any step fails, the instance stays in the cluster without the attribute, and the task is not placed there.

### Why privileged

ECS task definitions accept no seccomp or systempaths options: `dockerSecurityOptions` takes only no-new-privileges, apparmor, label and credentialspec. `privileged: true` is what gives the being box user namespaces and a fresh /proc. It is root-level power over the host, which is fine while EDW is alone on its instance.

With host networking, the container's hostname is the instance's (ip-10-88-1-x). eGPT uses the hostname only as a display label.

### oficina tunnel

The task's second container, `oficina-tunnel` (same image, not essential, egpt-home mounted read-only), forwards 127.0.0.1:18089 on the instance to oficina's whisper-server (127.0.0.1:8089 there) over SSH to oficina.eserviciosat.net:35547. It reads three files in `egpt-home/secrets/`: `oficina-tunnel.key` (the private key), `oficina.known_hosts` (oficina's pinned host keys, entries for `[oficina.eserviciosat.net]:35547`) and `oficina-tunnel.target` (`user@oficina.eserviciosat.net`). While one is missing it logs a line every 5 minutes. When ssh exits, ECS restarts the container (restart policy). A run lasts at least 65 s, because ECS never restarts a container that exits sooner, so a failing ssh retries about once a minute. Its log: `docker logs -f $(docker ps -lq --filter label=com.amazonaws.ecs.container-name=oficina-tunnel)`.

### Getting in (ECS)

- **The instance:** `aws ec2 describe-instances --filters Name=tag:Name,Values=edw-ecs-node Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text`, then SSM as above.
- **The container:** ECS names it `ecs-edw-<rev>-edw-<hex>`, so:
  - find it with `docker ps --filter label=com.amazonaws.ecs.container-name=edw`;
  - follow its logs with `docker logs -f $(docker ps -q --filter label=com.amazonaws.ecs.container-name=edw)`.
- **VNC:** with host networking, 5900 and 6080 listen on the instance itself; edw-sg has no inbound rules. Use the same port forward as above. The password is in `/srv/egpt/egpt-home/secrets/vnc.password` (`sudo cat` it).

### Costs (us-east-1, 10-24)

| Item | Per month |
|---|---|
| t3a.small Spot ($0.0057–0.0058/h in us-east-1a; t3.small $0.0060–0.0061/h) | ~$4–6 |
| t3a.small on-demand (`--on-demand`) | $13.72 |
| gp3: 30 GB root + 30 GB data | $4.80 (unchanged) |
| public IPv4 | $3.65 (unchanged) |
| ECR (~9 GB of images today) | ~$0.90 |
| ECS | free |

- In total, that is ≈ $13–16 on Spot and ≈ $23 on-demand.
- Until edw-node is terminated, its stopped 30 GB root adds $2.40. A stopped instance has no public IPv4 charge.
- Spot prices move. The ASG uses price-capacity-optimized over both pools.

## Notes

- IMDSv2 is required with hop limit 1, so the container cannot reach the instance role's credentials. This holds on the plain-EC2 path (bridge network). On ECS the task uses host networking, and the metadata guard above does this job.
- AmazonEC2ContainerServiceforEC2Role (on edw-ecs-role) is account-wide: it can register into or deregister from any cluster, and pull any ECR image. Only root on the ECS instance holds it, because of the metadata guard. EduWeb's cluster is Fargate-only (10-24).
- The instance role can only get and delete objects under `egpt-edw-transfer-<account>/migrate/`.
- Teardown is not scripted. Delete by tag `Project=egpt-edw`. The data volume outlives the instance on purpose.

### Resizing EDW in place (learned 2026-10-30)
Changing the instance type of the running instance (stop, modify, start) leaves the ECS agent refusing to start: "The current instance type does not match the registered instance type", and the egpt task never comes back. The steps that worked:
1. `aws autoscaling suspend-processes --auto-scaling-group-name edw-ecs-asg --scaling-processes HealthCheck ReplaceUnhealthy AZRebalance`
2. `aws ecs deregister-container-instance --cluster edw --container-instance <arn> --force`
3. Stop the instance, `modify-instance-attribute --instance-type`, start it (it keeps its private IP and the edw-data volume).
4. On the host: `systemctl stop ecs; rm -rf /var/lib/ecs/data/*; systemctl start ecs`, so the agent registers as a new container instance.
5. `aws autoscaling resume-processes …` (the same three), then set `TYPES` in deployments/edw.env and run `ecs-provision.sh --on-demand --apply`, so the launch template matches.

## Two Beeper accounts in one container (NU)

`EGPT_BEEPER` takes `off` (EDW), `on` (one Beeper, the default; unchanged), or a list of names. `EGPT_BEEPER=primary,secondary` runs one Beeper Desktop per name, both on the VNC screen, side by side:

| name | profile (`BEEPER_USER_DATA_DIR`) | Desktop API (`--pas-port`) | log |
|---|---|---|---|
| primary (first) | `/home/egpt/.config/BeeperTexts`, today's | 127.0.0.1:23373 | `/tmp/beeper-primary.log` |
| secondary | `/home/egpt/.config/BeeperTexts-secondary` | 127.0.0.1:23374 | `/tmp/beeper-secondary.log` |

- The port is a launch flag, not an app setting, so there is no port step in the app. egpt finds each Desktop by its token on 23373–23382 anyway.
- Each profile needs its own mount, or that login goes with the container (the entrypoint logs `is not a mounted volume`). NU's task definition mounts host dirs, e.g. `/srv/egpt/egpt-beeper` and `/srv/egpt/egpt-beeper-secondary`, at the two profile paths. Create them owned by 1000:1000 before the first task: Docker creates a missing source dir as root, and Beeper runs as egpt.
- Memory, measured before sign-in: ~0.45 GB per Beeper (PSS), ~0.9 GB for the two.

### One-time sign-ins

1. Open noVNC (port forward above). The left window is primary (ear), the right one secondary (mouth).
2. Sign each window into its own account: primary = the ear account, secondary = the mouth account.
3. Mint a token per Desktop: in that window, Settings > Developer > Desktop API, or from a shell in the container, `node ~/src/egpt/src/tools/beeper-mint-token.mjs --port 23373` (then `--port 23374`) and approve the prompt in that window.
4. Put them in `egpt-home/config/config.yaml` under `limbs.beeper.primary` and `limbs.beeper.secondary` (`account` + `token`, no `base_url`), and restart the container.
5. Verify: the daemon log shows `connection 'primary' → http://127.0.0.1:23373` and `connection 'secondary' → http://127.0.0.1:23374`; `node ~/src/egpt/src/tools/beeper-whoami.mjs` shows both.

## SSH into the container (`SSH_PORT`, NU)

`ssh nu` lands in NU's container as egpt, the way `ssh an@dolly` lands on the home PC: for the egpt shell (`node ~/src/egpt/egpt.mjs`), copying folders in and out, the VNC tunnel and the Claude login. The entrypoint runs sshd as egpt on `EGPT_SSH_PORT`: keys only, no agent or X11 forwarding, local forwards only. Log: `/tmp/sshd.log` in the container.

- `~/.ssh/config` on the PC; the address is the `ip` line of `ecs/ecs-provision.sh --deploy nu`:

  ```
  Host nu
    HostName <EIP>
    Port 2222
    User egpt
  ```
- **Keys:** `egpt-home/secrets/ssh/authorized_keys` on the data volume, not group- or world-writable. Without it sshd runs and lets no one in; the entrypoint logs where it goes. The first key goes in from an SSM session on the instance: `sudo docker exec -i $(sudo docker ps -q --filter label=com.amazonaws.ecs.container-name=nu) sh -c 'cat >>"$EGPT_HOME/secrets/ssh/authorized_keys"' <<<'<public key>'`.
- **Host key:** `secrets/ssh/ssh_host_ed25519_key`, made once on the data volume, so it is the same after a restart or on a new instance. The image ships no host keys.
- **Address:** the Elastic IP `nu-ip`. Each instance associates it at boot (`nu-address` allows that and nothing else); if that fails, the user data log says so and the task runs anyway. Re-running `ecs/ecs-provision.sh --deploy nu --apply` moves it to a running instance that lacks it. It costs what the auto-assigned IPv4 it replaces costs ($3.65/mo), also while no instance holds it.
- **VNC:** `ssh -N -L 16080:localhost:6080 nu`, then http://localhost:16080/vnc.html (password in `secrets/vnc.password`).
- **Claude login:** `ssh -t nu egpt-claude-token`. It runs `claude setup-token`, saves the token you paste (not shown) as `secrets/claude-oauth.token`, and offers to restart egpt. Sandboxed beings use it on their next turn, the others after the restart. SSH shells export it too.
- **Copying:** `tar -C <dir> -cf - . | ssh nu 'tar -C <dest> -xf -'`, and the other way round.
