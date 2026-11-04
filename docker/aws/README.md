# eGPT on AWS

Laptop-side bash scripts that put eGPT's container (`docker/Dockerfile`) on AWS, one node per deployment. Two paths:
- **ECS on EC2** (`ecs/`): one container instance from an Auto Scaling group, the container as an ECS service. The current path.
- **Plain EC2 + Docker** (`provision.sh`, `migrate.sh`, `run.sh`): one instance, the container run by hand over SSM. The older path; `ecs/ecs-cutover.sh` moves such a host to ECS.

Access is through SSM only: no key pair and no inbound port, unless the deployment sets `SSH_PORT`.

- Every script is a **dry run** that prints what it would do; `--apply` does it.
- Everything created is tagged `Project=$PROJECT` (and `Name=$N-*`) and found again by that tag. Untagged resources are never touched, and resources tagged with another project are refused. A Name alone never identifies ours: the account may hold other instances with similar names.
- Each `.sh` has a `.cmd` beside it that runs it in WSL (Ubuntu-22.04) with the same arguments, e.g. `ecs\ecs-provision.cmd --deploy <name> --apply`.

## Deployments

A deployment is a bash file `<name>.env`, sourced by `lib.sh`, and picked with `--deploy <name>` on any script or `.cmd`, or with `EGPT_AWS_DEPLOY=<name>`. With neither, the scripts stop and say so.

- `lib.sh` looks for `$EGPT_AWS_DEPLOYMENTS/<name>.env`. `EGPT_AWS_DEPLOYMENTS` defaults to `${EGPT_HOME:-~/.egpt}/config/aws-deployments`, outside the repo: a deployment file holds the account id, the profile, the network and the names.
- Then it falls back to `docker/aws/deployments/<name>.env` in the repo, which holds only `example.env`: synthetic values, every key with a comment. `--deploy example` dry-runs until the account check.
- A new deployment: copy `example.env` to `$EGPT_AWS_DEPLOYMENTS/<name>.env` and edit it.
- The `.cmd` wrappers run the scripts in WSL (`bash -lc`), so the variables must reach WSL. Set them in the WSL `~/.profile`, or pass them from Windows with `WSLENV`, e.g. `set WSLENV=EGPT_AWS_DEPLOY:EGPT_AWS_DEPLOYMENTS/p` (`/p` translates a Windows path). Otherwise `~/.egpt` in the WSL home is used.

Each file sets:
- the account: any other is refused, so a profile pointing at the wrong account stops the script;
- the profile, the region, and the `Project` tag. Nothing without that tag is touched;
- the name prefix `N`, which names:
  - the cluster, service, family and container `$N`;
  - `$N-ecs-lt`, `$N-ecs-asg`, `$N-ecs-role`, `$N-ecs-profile`, `$N-ecs-node`;
  - the data volume and its instance attribute, `$N-data`;
  - `$N-vpc`, `$N-igw`, `$N-public`, `$N-rt`, `$N-sg`;
  - the image tag, `egpt:$N`;
- `LABEL`, the display name in descriptions and boot logs;
- the CIDRs, the instance types (`TYPES`), the on-demand default, the data volume's size, swap, the memory reservation and `EGPT_BEEPER`.

What differs between deployments is a switch, not a branch on the name. Two examples, synthetic values:

| Key | Plain-EC2 legacy deployment | New deployment | Effect |
|---|---|---|---|
| `LEGACY_NODE` | `edw-node` | empty | The plain-EC2 host. With one: ecs-provision.sh reuses provision.sh's network and volume, ecs-cutover.sh migrates from it, and provision.sh, migrate.sh and run.sh run. Without one: ecs-provision.sh makes the network and the volume, ecs-cutover.sh is the first start, and the plain-EC2 scripts refuse. |
| `DATA_INIT` | empty | `format` | `format`: ecs-provision.sh tags the data volume it creates `DataInit=pending`; at boot the instance formats it only if it has no filesystem and that tag, creates `egpt-home`, and tags it `DataInit=done` (`$N-data-attach` allows that one tag). Anything else is never formatted. A new encrypted volume reads as random bytes, not zeros, so the tag is the only sign it is blank. Empty: never formats, and requires `egpt-home/config/config.yaml`. |
| `BUCKET` | `egpt-edw-transfer-123456789012` | `egpt-example-transfer-123456789012` | The private transfer bucket (migrate.sh makes and uses it). The instance role may only get and delete under its `migrate/` prefix (`$N-transfer` on ECS). Empty: no such policy. |
| `OFICINA_TUNNEL` | 1 | 0 | 1: the [tunnel sidecar](#the-tunnel-sidecar-oficina_tunnel) in the task definition. |
| `ZONE`, `DNS_NAME`, `ZONE_VPC` | `example.internal`, `edw.example.internal`, `vpc-0123456789abcdef0` | empty | A Route 53 private zone, ours (found by name + tag), associated with the VPC `ZONE_VPC`, e.g. a peered VPC whose services reach the node by name. At every boot the instance points the A record `DNS_NAME` at its private IP (`$N-dns`). Empty: none. |
| `ECR_UNTAGGED` | 1 | 0 | 1: the ECR repository `egpt` already exists without the Project tag (made by hand), and build-push.sh accepts it. 0: build-push.sh refuses an existing repo without the deployment's tag. |
| `SSH_PORT` | empty | 2222 | [SSH into the container](#ssh-into-the-container-ssh_port): sshd as egpt on that port (`EGPT_SSH_PORT` in the task definition), tcp `SSH_PORT` from anywhere in `$N-sg`, and the Elastic IP `$N-ip`, which the instance associates at boot (`$N-address`). Empty: none of these. |
| `SSH_PERMIT_LISTEN` | empty | `127.0.0.1:22001 127.0.0.1:22002` | With `SSH_PORT`: [reverse tunnels into the container](#ssh-into-the-container-ssh_port). sshd also allows `ssh -R`, listening only on these `host:port` (`EGPT_SSH_PERMIT_LISTEN`). Empty: local forwards only. |
| `ROOT_SUDO` | 0 | 1 | 1: [root in the container](#root-in-the-container-root_sudo), egpt may sudo anything. 0 or absent: the plain image. |

The plain-EC2 scripts predate deployment files and keep fixed names: the container `edw`, `edw-node`, `edw-data`, `edw-instance-role`, the tag `egpt:edw`. A deployment that uses them sets `N=edw` and `LEGACY_NODE=edw-node`.

## A new deployment (ECS), the first time

1. **`build-push.sh --deploy <name> --apply`**, from a plain checkout in WSL. It creates ECR `egpt` tagged `Project=$PROJECT` (when missing) and pushes `egpt:<sha>` and `egpt:$N`.
2. **`ecs/ecs-provision.sh --deploy <name> --apply`** creates, in order:
   - the VPC `VPC_CIDR` with its gateway, subnet, routes, and `$N-sg`, with no inbound rule (with `SSH_PORT`: tcp `SSH_PORT` only);
   - `$N-data`, an empty, encrypted gp3 volume of `DATA_GB`;
   - with `SSH_PORT`, the Elastic IP `$N-ip`;
   - the role, the profile, the cluster, the launch template, the ASG (at 0), the task definition and the service (at 0).
3. **`ecs/ecs-cutover.sh --deploy <name> --apply`**. With no plain-EC2 node, it scales the ASG to 1, waits for `$N-data` to be mounted, and sets the service to 1.
   - With `DATA_INIT=format`, at its first boot the instance formats the blank `$N-data` and creates `egpt-home`.
   - The entrypoint then seeds `config/config.yaml` and `secrets/vnc.password`.
   - `--rollback` is refused, because there is nothing to roll back to.
4. Then the node's own setup: its config, the Claude token, the Beeper sign-ins over VNC.

Notes:
- When `EGPT_BEEPER` is not `off`, each Beeper profile lives on the data volume, so sign-ins survive a new task.
  - The first account's `~/.config/BeeperTexts` is mounted from `/srv/egpt/egpt-beeper`, and each other account's `~/.config/BeeperTexts-<name>` from `/srv/egpt/egpt-beeper-<name>`.
  - The instance creates these dirs owned by 1000:1000 at every boot, with the others.
  - See [Two Beeper accounts](#two-beeper-accounts-in-one-container).
- Two Beepers took ~0.9 GB before sign-in. To change the instance size, change `TYPES` and re-run ecs-provision.sh, then follow [Resizing in place](#resizing-an-ecs-instance-in-place) for the running instance.
- Teardown is by tag, `Project=$PROJECT`.

## Plain EC2

### Order

1. **`build-push.sh --apply`** builds the image from the checkout it sits in, tags it `egpt:<sha>` and `egpt:$N`, and pushes both to ECR `egpt`. The image is ~3.2 GB (~1.3 GB compressed); it carries no whisper model, since models live on the data volume.
2. **`provision.sh [--type t3a.medium] --apply`** creates the VPC, subnet, internet gateway, route table, a security group with no inbound rules, the instance role, a `DATA_GB` data volume and the instance, then prints the instance id, AZ and IPs. The first boot (a few minutes; log in `/var/log/cloud-init-output.log`) installs Docker, adds a 4 GB swap file, and mounts the data volume at `/srv/egpt`.
3. **`migrate.sh --apply`** checks that the instance's targets are empty, then stops the local `edw` (restart=no). It tars egpt-home and egpt-claude, moves them through the private encrypted bucket `BUCKET` into `/srv/egpt`, and deletes the S3 objects. Local volumes are not touched.
4. **`run.sh --apply`** (from WSL) copies itself to the instance over SSM and starts `edw` from `egpt:edw` with `EGPT_BRANCH=main` and `EGPT_BEEPER=off`. Run it again after each build-push to replace the container (stop, rm, run). `--tag <sha>` runs an older build.
5. **Verify:** the beings answer on Telegram.
6. **Later**, once AWS has proven itself, delete the local container: `docker rm edw` (and its volumes when sure).

### One poller

A bot token allows one long-polling client. A second copy of a node (laptop + AWS) gets 409 Conflict, and the beings answer twice. That is why migrate.sh stops the local container before copying anything, and why the ECS service never runs two tasks.

To fall back, first stop AWS (`sudo docker stop edw` on the instance), then on the laptop run `docker update --restart unless-stopped edw && docker start edw`. Anything the node wrote on AWS after the cutover stays there.

### Getting in

- **Shell:** `aws ssm start-session --target <instance-id>`, then `sudo -i`. This needs the Session Manager plugin in WSL: https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-debian-and-ubuntu.html
  - On the instance: `docker logs -f edw`; `bash /srv/egpt/run.sh` (dry run there).
- **Without the plugin:** `aws ssm send-command` works, and it is what run.sh and migrate.sh use.
- **VNC:** the container publishes 5900/6080 on the instance's 127.0.0.1 only. Forward noVNC to the laptop (plugin needed):

  ```
  aws ssm start-session --target <instance-id> --document-name AWS-StartPortForwardingSession \
    --parameters '{"portNumber":["6080"],"localPortNumber":["16080"]}'
  ```

  Then open http://localhost:16080/vnc.html. The password is in `/srv/egpt/vnc.env` (`sudo cat` it in a session).

### Resize

The state lives on the data volume, so a resize is stop, change, start:

```
aws ec2 stop-instances --instance-ids <id> && aws ec2 wait instance-stopped --instance-ids <id>
aws ec2 modify-instance-attribute --instance-id <id> --instance-type '{"Value":"t3a.large"}'
aws ec2 start-instances --instance-ids <id>
```

The public IP changes (nothing depends on it), and Docker restarts `edw` on boot.

## ECS on EC2 (`ecs/`)

ECS runs the node's container, so nobody manages the instance by hand. There is one container instance, from an Auto Scaling group (min = max = 1) in `$N-public`, the data volume's AZ. By default it is Spot, from the `TYPES` pools (`--on-demand` or `ON_DEMAND=1` takes the first type on-demand). When Spot takes the instance back, the ASG launches another one, which re-attaches `$N-data`, and ECS starts the task there. That is a few minutes of downtime, mostly the ~1.3 GB image pull.

The rules are the same as above: dry run unless `--apply`, everything tagged `Project=$PROJECT`, and a `.cmd` beside each script.

### Order

1. **`build-push.sh --apply`**. The entrypoint reads the VNC password from `secrets/vnc.password` (made once, 0600) when `VNC_PASSWORD` is unset, so the task definition carries no password.
2. **`ecs/ecs-provision.sh [--on-demand] --apply`** creates:
   - the role `$N-ecs-role` with its profile `$N-ecs-profile`. It has the plain-EC2 role's policies (SSM, ECR read, and `$N-transfer` with a `BUCKET`), plus AmazonEC2ContainerServiceforEC2Role, plus:
     - `$N-data-attach`: AttachVolume only on the volume tagged `Project=$PROJECT` + `Name=$N-data` and on our tagged instances, and DescribeVolumes (with `DATA_INIT=format`, also the `DataInit=done` tag on that volume);
     - with a `ZONE`, `$N-dns`: UPSERT of the A record `DNS_NAME` in our zone, nothing else;
     - with `SSH_PORT`, `$N-address`: associating `$N-ip` with our tagged instances;
   - with a `ZONE`, the Route 53 private zone, found by name + tag, associated with `ZONE_VPC`;
   - the cluster `$N`;
   - the launch template `$N-ecs-lt`: the ECS-optimized Amazon Linux 2023 AMI (resolved when the script runs), IMDSv2 with hop limit 1, an encrypted 30 GB gp3 root, `$N-sg`, a public IPv4, and the user data below;
   - the ASG `$N-ecs-asg`, at 0;
   - the task definition `$N`, its first revision at `egpt:$N`'s digest;
   - the service `$N`, at 0, with min 0 / max 100 % and a circuit breaker that rolls back.

   With a `LEGACY_NODE` it reuses provision.sh's subnet, security group and data volume instead of making them. Re-run it to move to a newer AMI (a new template version, used by the next instance) or to switch to `--on-demand`.
3. **`ecs/ecs-cutover.sh --apply`**, with a `LEGACY_NODE`, does, in order:
   - stops `edw` on `LEGACY_NODE` and sets it to restart=no;
   - stops `LEGACY_NODE`, which is kept, not terminated;
   - detaches `$N-data` and scales the ASG to 1;
   - waits for the new instance to mount `$N-data` (ECS attribute `$N-data=mounted`);
   - sets the service to 1 and waits for it to settle.

   Without one it is the first start (see above).
4. **Verify** on Telegram.
5. **Later**, terminate `LEGACY_NODE`: `aws ec2 terminate-instances --instance-ids <id>`. Its root volume goes with it; `$N-data` stays. Until then, `ecs/ecs-cutover.sh --rollback --apply` reverses the cutover: service to 0, ASG to 0, `$N-data` back on `LEGACY_NODE`, then `LEGACY_NODE` and its `edw` started.

### Deploy

Run `build-push.sh --apply`, then `ecs/ecs-deploy.sh --apply`. It registers a task-definition revision pinned to the image's current digest and points the service at it. The old task stops before the new one starts, so there is one Telegram poller at a time.
- `--tag <sha>` deploys an older build.
- `--restart` replaces the task when nothing changed.
- If the new task cannot start, the circuit breaker rolls back, and the script says so.

### The instance's first boot

The user data logs to `/var/log/cloud-init-output.log`. In order, it:
- writes the ECS config: `ECS_CLUSTER=$N`, task IAM roles off, Spot draining on;
- adds a **metadata guard** (`$N-imds-guard.service`): an iptables rule that lets only root reach 169.254.169.254.
  - Why: the task uses host networking, so hop limit 1 no longer keeps the container away from the role's credentials. Those credentials hold AttachVolume, the ECS agent's rights, and SSM GetParameter on the whole account.
  - The ECS and SSM agents run as root. The container runs as egpt (uid 1000) and the being boxes as uid 200000 and up.
- sets up Docker log rotation and the hostname `$N`;
- with a `ZONE`, installs `$N-dns.service`, which at every boot UPSERTs `DNS_NAME` A to the instance's private IP (IMDSv2 `local-ipv4`), retrying for 3 min. Log: `journalctl -u $N-dns`, also on the console. If it fails, the record keeps its old address and the rest of the setup goes on;
- adds a `SWAP_MB` swap file;
- attaches `$N-data`, waiting up to 20 min while a previous instance lets go of it, and mounts it at `/srv/egpt` by UUID. With `DATA_INIT=format` it formats a blank, `DataInit=pending` volume first (see the table); otherwise it never formats, and it requires `egpt-home/config/config.yaml` to be there;
- with `SSH_PORT`, associates the Elastic IP `$N-ip` (a failure is logged; the task still runs);
- creates the other data dirs (`egpt-claude`, `egpt-src`, `egpt-jsonl`, the Beeper profiles) owned by 1000:1000;
- only then sets the attribute `$N-data=mounted`, which the task requires, and makes the ECS agent require the mount on later boots.

If any step fails, the instance stays in the cluster without the attribute, and the task is not placed there.

### Why privileged

ECS task definitions accept no seccomp or systempaths options: `dockerSecurityOptions` takes only no-new-privileges, apparmor, label and credentialspec. `privileged: true` is what gives the being box user namespaces and a fresh /proc. It is root-level power over the host, which is fine while the node is alone on its instance.

With host networking the container would take the instance's name (e.g. `ip-10-0-1-23`); the user data sets the hostname to `$N`, as the old container had it (sudo, Chrome profile locks). eGPT uses the hostname only as a display label.

### The tunnel sidecar (`OFICINA_TUNNEL`)

With `OFICINA_TUNNEL=1` the task has a second container, `oficina-tunnel` (same image, not essential, egpt-home mounted read-only). It is an SSH local forward: 127.0.0.1:18089 on the instance to 127.0.0.1:8089 on a whisper server, so the node can hand voice notes to a bigger machine. It reads three files in `egpt-home/secrets/`:
- `oficina-tunnel.key`, the private key;
- `oficina.known_hosts`, the server's pinned host keys (entries for `[host]:port`);
- `oficina-tunnel.target`, `user@host`.

The SSH port is the deployment's `OFICINA_TUNNEL_PORT` (required with `OFICINA_TUNNEL=1`). The container never exits on its own: while a file is missing it says so and checks again every minute, and when ssh exits it retries a minute later. ECS's restart policy is only a backstop. Its log: `docker logs -f $(docker ps -lq --filter label=com.amazonaws.ecs.container-name=oficina-tunnel)`.

### Getting in (ECS)

- **The instance:** `aws ec2 describe-instances --filters Name=tag:Name,Values=$N-ecs-node Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text`, then SSM as above.
- **The container:** ECS names it `ecs-$N-<rev>-$N-<hex>`, so:
  - find it with `docker ps --filter label=com.amazonaws.ecs.container-name=$N`;
  - follow its logs with `docker logs -f $(docker ps -q --filter label=com.amazonaws.ecs.container-name=$N)`.
- **VNC:** with host networking, 5900 and 6080 listen on the instance itself; `$N-sg` has no inbound rule for them. Use the same port forward as above, or SSH (below). The password is in `/srv/egpt/egpt-home/secrets/vnc.password` (`sudo cat` it).

### Resizing an ECS instance in place

Changing the instance type of the running instance (stop, modify, start) leaves the ECS agent refusing to start: "The current instance type does not match the registered instance type", and the task never comes back. The steps that work:
1. `aws autoscaling suspend-processes --auto-scaling-group-name $N-ecs-asg --scaling-processes HealthCheck ReplaceUnhealthy AZRebalance`
2. `aws ecs deregister-container-instance --cluster $N --container-instance <arn> --force`
3. Stop the instance, `modify-instance-attribute --instance-type`, start it (it keeps its private IP and the `$N-data` volume).
4. On the host: `systemctl stop ecs; rm -rf /var/lib/ecs/data/*; systemctl start ecs`, so the agent registers as a new container instance.
5. `aws autoscaling resume-processes …` (the same three), then set `TYPES` in the deployment file and run `ecs-provision.sh --apply` (`--on-demand` as before), so the launch template matches.

## Two Beeper accounts in one container

`EGPT_BEEPER` takes `off`, `on` (one Beeper, the default), or a list of names. `EGPT_BEEPER=primary,secondary` runs one Beeper Desktop per name, both on the VNC screen, side by side:

| name | profile (`BEEPER_USER_DATA_DIR`) | Desktop API (`--pas-port`) | log |
|---|---|---|---|
| primary (first) | `/home/egpt/.config/BeeperTexts`, the single-Beeper one | 127.0.0.1:23373 | `/tmp/beeper-primary.log` |
| secondary | `/home/egpt/.config/BeeperTexts-secondary` | 127.0.0.1:23374 | `/tmp/beeper-secondary.log` |

- The port is a launch flag, not an app setting, so there is no port step in the app. egpt finds each Desktop by its token on 23373–23382 anyway.
- Each profile needs its own mount, or that login goes with the container (the entrypoint logs `is not a mounted volume`). The ECS task definition mounts host dirs, e.g. `/srv/egpt/egpt-beeper` and `/srv/egpt/egpt-beeper-secondary`, at the profile paths, and the instance creates them owned by 1000:1000: Docker would create a missing source dir as root, and Beeper runs as egpt.
- Memory, measured before sign-in: ~0.45 GB per Beeper (PSS), ~0.9 GB for the two.

### One-time sign-ins

1. Open noVNC (port forward above). The left window is primary, the right one secondary.
2. Sign each window into its own account, e.g. primary = the ear account, secondary = the mouth account.
3. Mint a token per Desktop: in that window, Settings > Developer > Desktop API, or from a shell in the container, `node ~/src/egpt/src/tools/beeper-mint-token.mjs --port 23373` (then `--port 23374`) and approve the prompt in that window.
4. Put them in `egpt-home/config/config.yaml` under `limbs.beeper.primary` and `limbs.beeper.secondary` (`account` + `token`, no `base_url`), and restart the container.
5. Verify: the daemon log shows `connection 'primary' → http://127.0.0.1:23373` and `connection 'secondary' → http://127.0.0.1:23374`; `node ~/src/egpt/src/tools/beeper-whoami.mjs` shows both.

## SSH into the container (`SSH_PORT`)

`ssh <name>` lands in the node's container as egpt: for the egpt shell (`node ~/src/egpt/egpt.mjs`), copying folders in and out, the VNC tunnel and the Claude login. The entrypoint runs sshd as egpt on `EGPT_SSH_PORT`: keys only, no agent or X11 forwarding, local forwards only (plus the reverse tunnels below). Log: `/tmp/sshd.log` in the container.

- `~/.ssh/config` on the PC; the address is the `ip` line of `ecs/ecs-provision.sh --deploy <name>`:

  ```
  Host <name>
    HostName <EIP>
    Port <SSH_PORT>
    User egpt
  ```
- **Keys:** `egpt-home/secrets/ssh/authorized_keys` on the data volume, not group- or world-writable. Without it sshd runs and lets no one in; the entrypoint logs where it goes. The first key goes in from an SSM session on the instance: `sudo docker exec -i $(sudo docker ps -q --filter label=com.amazonaws.ecs.container-name=$N) sh -c 'cat >>"$EGPT_HOME/secrets/ssh/authorized_keys"' <<<'<public key>'`.
- **Host key:** `secrets/ssh/ssh_host_ed25519_key`, made once on the data volume, so it is the same after a restart or on a new instance. The image ships no host keys.
- **Address:** the Elastic IP `$N-ip`. Each instance associates it at boot (`$N-address` allows that and nothing else); if that fails, the user data log says so and the task runs anyway. Re-running `ecs/ecs-provision.sh --deploy <name> --apply` moves it to a running instance that lacks it. It costs what the auto-assigned IPv4 it replaces costs, also while no instance holds it.
- **VNC:** `ssh -N -L 16080:localhost:6080 <name>`, then http://localhost:16080/vnc.html (password in `secrets/vnc.password`).
- **Claude login:** `ssh -t <name> egpt-claude-token`. It runs `claude setup-token`, saves the token you paste (not shown) as `secrets/claude-oauth.token`, and offers to restart egpt. Sandboxed beings use it on their next turn, the others after the restart. SSH shells export it too.
- **Copying:** `tar -C <dir> -cf - . | ssh <name> 'tar -C <dest> -xf -'`, and the other way round.
- **Reverse tunnels (`SSH_PERMIT_LISTEN`):** PCs keep `ssh -N -R 127.0.0.1:<port>:localhost:<their sshd port> <name>` up, so the node's beings reach each PC's sshd at 127.0.0.1:`<port>`. sshd then runs with `AllowTcpForwarding yes` and `PermitListen` set to `SSH_PERMIT_LISTEN`; any other `-R` is refused. GatewayPorts stays `no`, so the listeners are loopback only. The client must ask for `127.0.0.1` explicitly: a bare `-R <port>:…` asks for `localhost`, which `PermitListen` does not match.

## Root in the container (`ROOT_SUDO`)

With `ROOT_SUDO=1` in the deployment, build-push.sh builds with `--build-arg EGPT_ROOT_SUDO=1`. The image then has `/etc/sudoers.d/egpt-root`, `egpt ALL=(ALL) NOPASSWD:ALL` (mode 0440, checked with `visudo -cf` at build time), and the label `egpt.root_sudo=1`. With 0 or no key, the image has neither the file nor any sudo beyond the egpt-box line, and its label is `egpt.root_sudo=0`. build-push.sh prints which kind it is building, and the built image's label. It takes effect with the next build-push.sh and `ecs/ecs-deploy.sh`.

- **What it grants:** every process running as egpt may run anything as root in the container, with no password.
- **On ECS that is root on the instance.** The task is `privileged: true` with host networking, so root in the container has the host's devices and kernel. The [metadata guard](#the-instances-first-boot) lets uid 0 through, so it also gets the instance role's credentials.
- **Who gets it:** the spine and the beings that run unboxed as egpt (`access_level: all`). A boxed being (`access_level: sandbox`, the default) runs as its own uid with no_new_privs, and it cannot sudo, with or without `ROOT_SUDO`.
- **Single-owner personal nodes only**, where the owner wants the beings to have the whole machine. Never on a node that serves other people.
- To check an image: `docker image inspect -f '{{index .Config.Labels "egpt.root_sudo"}}' <image>`.

## Notes

- IMDSv2 is required with hop limit 1, so the container cannot reach the instance role's credentials. This holds on the plain-EC2 path (bridge network). On ECS the task uses host networking, and the metadata guard above does this job.
- AmazonEC2ContainerServiceforEC2Role (on `$N-ecs-role`) is account-wide: it can register into or deregister from any cluster, and pull any ECR image. Only root on the ECS instance holds it, because of the metadata guard. Mind it in an account that runs other EC2-backed clusters.
- The instance role can only get and delete objects under `BUCKET/migrate/`.
- Sizing: whisper large-v3 needs 3–4 GB, so a 2 GB type is too small for voice notes; a 4 GB type (t3a.medium) runs it with the swap file as a safety net. Besides the instance, a deployment pays for gp3 storage (root + data), the public IPv4 (or the Elastic IP), ECR storage (old tags accumulate), and, on t3/t3a, CPU above the baseline (unlimited credits by default). Spot prices move; the ASG uses price-capacity-optimized over the `TYPES` pools.
- Teardown is not scripted. Delete by tag `Project=$PROJECT`. The data volume outlives the instance on purpose.
