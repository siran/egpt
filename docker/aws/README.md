# EDW on AWS

EDW (eGPT in one container) on one EC2 instance in EduWeb's account (331665579468, us-east-1, WSL profile `eduweb`). Plain EC2 + Docker. Access is through SSM only: no key pair, no inbound port.

The move to ECS on EC2 is in [ECS on EC2](#ecs-on-ec2-ecs) below. After the cutover, `ecs/ecs-deploy.sh` replaces `run.sh`.

- Every script is a **dry run** that prints what it would do; `--apply` does it.
- Everything created is tagged `Project=egpt-edw` (and `Name=edw-*`) and found again by that tag. Untagged resources are never touched. The account runs EduWeb production, and one of its instances is named `edw-Sun…`, so a Name alone never identifies ours.
- Each `.sh` has a `.cmd` beside it that runs it in WSL (Ubuntu-22.04) with the same arguments, e.g. `provision.cmd --apply`.

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
   - the role `edw-ecs-role` with its profile `edw-ecs-profile`. It has edw-instance-role's policies (SSM, ECR read, edw-transfer), plus AmazonEC2ContainerServiceforEC2Role, plus `edw-data-attach`: AttachVolume only on the volume tagged `Project=egpt-edw` + `Name=edw-data` and on our tagged instances, and DescribeVolumes;
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
