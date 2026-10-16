import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { HostVault } from "./vault";

describe("host credential vault", () => {
  test("protects credentials, retains identity across restarts, and never replaces corrupt wrapping material", async () => {
    const root = mkdtempSync(join(tmpdir(), "chorus-vault-"));
    const directory = join(root, "host");
    let vault: HostVault | undefined;
    try {
      vault = await HostVault.open(directory);
      const identity = vault.identity();
      expect("privateKey" in identity).toBe(false);
      const connection = {
        audience: "https://accounts.example.com/tunnel",
        clientId: "test-host-client",
        clientSecret: "test-machine-credential-not-in-database-plaintext",
        hostId: identity.hostId,
        hostname: "h-one.hosts.example.net",
        issuer: "https://accounts.example.com/api/auth",
        serverUrl: "https://connect.example.com",
        tokenEndpoint: "https://accounts.example.com/api/auth/oauth2/token",
      };
      vault.saveConnection(connection);
      expect(() =>
        vault?.saveConnection({ ...connection, hostId: crypto.randomUUID() })
      ).toThrow();
      const data = [
        join(directory, "vault.db"),
        join(directory, "vault.db-wal"),
      ]
        .filter(existsSync)
        .map((file) => readFileSync(file).toString("utf8"))
        .join("");
      expect(data).not.toContain(connection.clientSecret);
      expect(data).not.toContain("BEGIN PRIVATE KEY");
      vault.close();
      vault = await HostVault.open(directory);
      expect(vault.identity()).toEqual(identity);
      expect(vault.connection()).toEqual(connection);
      vault.clearConnection();
      expect(vault.connection()).toBeNull();
      if (process.platform !== "win32") {
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX permission bits
        expect(statSync(join(directory, "wrapping.key")).mode & 0o777).toBe(
          0o600
        );
      }
      vault.close();
      vault = undefined;
      writeFileSync(join(directory, "wrapping.key"), "corrupt");
      await expect(HostVault.open(directory)).rejects.toThrow("corrupt");
      expect(readFileSync(join(directory, "wrapping.key"), "utf8")).toBe(
        "corrupt"
      );
    } finally {
      vault?.close();
      if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}`)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
