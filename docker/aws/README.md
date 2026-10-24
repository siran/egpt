# EDW on AWS

EDW (eGPT in one container) on one EC2 instance in EduWeb's account (331665579468, us-east-1, WSL profile `eduweb`). Plain EC2 + Docker. Access is through SSM only: no key pair, no inbound port.

- Every script is a **dry run** that prints what it would do; `--apply` does it.
- Everything created is tagged `Project=egpt-edw` (and `Name=edw-*`) and found again by that tag. Untagged resources are never touched. The account runs EduWeb production, and one of its instances is named `edw-Sun…`, so a Name alone never identifies ours.
- Each `.sh` has a `.cmd` beside it that runs it in WSL (Ubuntu-22.04) with the same arguments, e.g. `provision.cmd --apply`.

## Order

1. **`build-push.sh --apply`** builds the image from the checkout it sits in (the whisper model comes from `~/egpt-assets`), tags it `egpt:<sha>` and `egpt:edw`, and pushes both to ECR `egpt`. The image is ~6 GB; ~3 GB is the model layer, which later builds reuse.
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

## Notes

- IMDSv2 is required with hop limit 1, so the container cannot reach the instance role's credentials.
- The instance role can only get and delete objects under `egpt-edw-transfer-<account>/migrate/`.
- Teardown is not scripted. Delete by tag `Project=egpt-edw`. The data volume outlives the instance on purpose.
