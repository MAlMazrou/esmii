import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function source(path) {
  return readFile(join(repositoryRoot, path), "utf8");
}

describe("Ansible first-host safety", () => {
  it("keeps SSH lock-down and host-firewall activation out of bootstrap defaults", async () => {
    const [variables, inventoryExample, sshTasks, sshPolicy, firewallTasks] = await Promise.all([
      source("infra/ansible/inventories/netcup/group_vars/all.yml"),
      source("infra/ansible/inventories/netcup/hosts.example.yml"),
      source("infra/ansible/roles/ssh/tasks/main.yml"),
      source("infra/ansible/roles/ssh/templates/60-esmii.conf.j2"),
      source("infra/ansible/roles/firewall/tasks/main.yml"),
    ]);

    expect(variables).toContain("esmii_disable_ssh_passwords: false");
    expect(variables).toContain("esmii_enable_host_firewall: false");
    expect(inventoryExample).toContain("esmii_second_session_confirmed: false");
    expect(sshTasks).toContain("- esmii_disable_ssh_passwords | bool");
    expect(firewallTasks).toContain(
      "Require both recovery paths before enabling the host firewall",
    );
    expect(
      firewallTasks.match(/- esmii_enable_host_firewall \| bool/gu)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(sshPolicy).toContain("PermitEmptyPasswords no");
    expect(sshPolicy).toContain("AllowTcpForwarding no");

    const firewallActivation = firewallTasks.indexOf(
      "Activate the default-deny host firewall after staging ingress rules",
    );
    expect(firewallActivation).toBeGreaterThan(
      firewallTasks.indexOf("Allow SSH only from approved IPv4 administrator networks"),
    );
    expect(firewallActivation).toBeGreaterThan(
      firewallTasks.indexOf("Allow the authenticated WireGuard administrator tunnel"),
    );
    expect(firewallActivation).toBeGreaterThan(firewallTasks.indexOf("Allow public web ingress"));
  });

  it("plans clean-host dependencies without mutating them during check mode", async () => {
    const [baselineTasks, userTasks, dockerTasks, directoryTasks] = await Promise.all([
      source("infra/ansible/roles/baseline/tasks/main.yml"),
      source("infra/ansible/roles/users/tasks/main.yml"),
      source("infra/ansible/roles/docker/tasks/main.yml"),
      source("infra/ansible/roles/directories/tasks/main.yml"),
    ]);

    expect(baselineTasks).toContain("Apply all available Ubuntu package updates");
    expect(baselineTasks).toContain(
      "Record the planned swap permissions during first-host check mode",
    );
    expect(baselineTasks).toContain("- not ansible_check_mode");
    expect(userTasks).toContain("Read existing host accounts before planning users");
    expect(userTasks).toContain("Record the planned operator key during first-host check mode");
    expect(dockerTasks).toContain(
      "Record the deferred Compose version gate during first-host check mode",
    );
    expect(directoryTasks).toContain(
      "Record directories whose service owners are planned in check mode",
    );
  });

  it("never runs service-reload handlers during a dry run", async () => {
    const handlers = await Promise.all(
      ["docker", "ssh", "systemd", "wireguard"].map((role) =>
        source(`infra/ansible/roles/${role}/handlers/main.yml`),
      ),
    );

    for (const handler of handlers) {
      expect(handler).toContain("when: not ansible_check_mode");
    }
  });

  it("gates and validates the dedicated operator passwordless sudo policy", async () => {
    const [variables, inventoryExample, userTasks] = await Promise.all([
      source("infra/ansible/inventories/netcup/group_vars/all.yml"),
      source("infra/ansible/inventories/netcup/hosts.example.yml"),
      source("infra/ansible/roles/users/tasks/main.yml"),
    ]);

    expect(variables).toContain("esmii_enable_operator_passwordless_sudo: false");
    expect(inventoryExample).toContain("esmii_operator_key_session_confirmed: false");
    expect(userTasks).toContain("Require a proven keyed operator session before passwordless sudo");
    expect(userTasks).toContain("NOPASSWD: ALL");
    expect(userTasks).toContain("validate: /usr/sbin/visudo -cf %s");
  });

  it("keeps WireGuard opt-in, secret-safe, and independent of the firewall gate", async () => {
    const [playbook, variables, inventoryExample, tasks, template, validator, firewallTasks] =
      await Promise.all([
        source("infra/ansible/playbooks/vps.yaml"),
        source("infra/ansible/inventories/netcup/group_vars/all.yml"),
        source("infra/ansible/inventories/netcup/hosts.example.yml"),
        source("infra/ansible/roles/wireguard/tasks/main.yml"),
        source("infra/ansible/roles/wireguard/templates/wg.conf.j2"),
        source("infra/ansible/roles/wireguard/files/esmii-validate-wireguard-config"),
        source("infra/ansible/roles/firewall/tasks/main.yml"),
      ]);

    expect(playbook).toContain("- role: wireguard");
    expect(variables).toContain("esmii_enable_wireguard: false");
    expect(inventoryExample).toContain(
      "esmii_wireguard_server_private_key_file: <IGNORED_LOCAL_WIREGUARD_SERVER_PRIVATE_KEY_PATH>",
    );
    expect(tasks).toContain("no_log: true");
    expect(tasks).toContain("validate: /usr/local/sbin/esmii-validate-wireguard-config %s");
    expect(tasks).toContain("Enable and start only the reviewed WireGuard interface");
    expect(validator).toContain('"$validation_root/wg0.conf"');
    expect(validator).toContain("/etc/wireguard/esmii-validate.XXXXXX");
    expect(validator).toContain("/usr/bin/wg-quick strip");
    expect(template).toContain("AllowedIPs = {{ esmii_wireguard_admin_address }}");
    expect(firewallTasks).toContain("Allow the authenticated WireGuard administrator tunnel");
  });
});
