// tests/docker-root-sudo.test.mjs — ROOT_SUDO: the deployment key reaches the image as EGPT_ROOT_SUDO, off by default.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const GRANT = 'egpt ALL=(ALL) NOPASSWD:ALL';

describe('ROOT_SUDO: root sudo in the image, per deployment, off by default', () => {
  const dockerfile = read('docker/Dockerfile');
  const lib = read('docker/aws/lib.sh');
  const build = read('docker/aws/build-push.sh');

  it('lib.sh defaults ROOT_SUDO to 0 before it sources the deployment; example.env lists it at 0', () => {
    const def = lib.search(/^ROOT_SUDO=0\b/m);
    expect(def).toBeGreaterThan(-1);
    expect(def).toBeLessThan(lib.indexOf('. "$DEPLOY_ENV"'));
    expect(read('docker/aws/deployments/example.env')).toMatch(/^ROOT_SUDO=0\b/m);
  });

  it('build-push.sh passes it to docker build as EGPT_ROOT_SUDO and refuses anything but 0 or 1', () => {
    expect(build).toMatch(/^run docker build [^\n]*--build-arg "EGPT_ROOT_SUDO=\$ROOT_SUDO"/m);
    expect(build).toMatch(/^ {2}\*\) die "ROOT_SUDO must be 0 or 1/m);
  });

  it('the Dockerfile arg defaults to 0; only 1 installs the grant, validated, before USER egpt; the label follows the arg', () => {
    expect(dockerfile).toMatch(/^ARG EGPT_ROOT_SUDO=0$/m);
    expect(dockerfile).toMatch(/^ {6}0\) ;; \\$/m);
    expect(dockerfile.split(GRANT)).toHaveLength(2);
    const branch = dockerfile.slice(dockerfile.indexOf(" 1) echo '"), dockerfile.indexOf(';;', dockerfile.indexOf(" 1) echo '")));
    expect(branch).toContain(`echo '${GRANT}' >/etc/sudoers.d/egpt-root`);
    expect(branch).toContain('chmod 440 /etc/sudoers.d/egpt-root');
    expect(branch).toContain('visudo -cf /etc/sudoers.d/egpt-root');
    expect(dockerfile).toMatch(/^ {6}\*\) echo "EGPT_ROOT_SUDO must be 0 or 1[^\n]*exit 1 ;;/m);
    expect(dockerfile.indexOf(GRANT)).toBeLessThan(dockerfile.indexOf('\nUSER egpt'));
    expect(dockerfile).toMatch(/^LABEL egpt\.root_sudo=\$EGPT_ROOT_SUDO$/m);
  });

  it('the plain image keeps only the egpt-box sudoers line', () => {
    expect(read('docker/sudoers-egpt-box')).not.toMatch(/NOPASSWD:\s*ALL/);
  });
});
