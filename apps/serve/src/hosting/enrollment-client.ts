import {
  type RelayOperatorConfig,
  relayEnrollmentChallengeSchema,
  relayEnrollmentPollResponseSchema,
  relayOperatorConfigSchema,
  validateRelayConnection,
} from "@chorus/contracts";
import { z } from "zod";
import { publicKeyHash } from "./signatures";
import type { HostVault } from "./vault";

export class RemoteConnectionError extends Error {
  readonly code: "relay_unreachable" | "relay_rejected" | "enrollment_expired";
  constructor(code: RemoteConnectionError["code"]) {
    super(code);
    this.name = "RemoteConnectionError";
    this.code = code;
  }
}

/** Relay polling credentials never reach browser responses or WS events. */
export class HostEnrollmentClient {
  readonly #operator: RelayOperatorConfig;
  readonly #vault: HostVault;
  readonly #signal: AbortSignal | undefined;

  constructor(
    operator: RelayOperatorConfig,
    vault: HostVault,
    signal?: AbortSignal
  ) {
    this.#operator = relayOperatorConfigSchema.parse(operator);
    this.#vault = vault;
    this.#signal = signal;
  }

  challenge() {
    const current = this.#vault.enrollment();
    return current && current.expiresAt > Date.now()
      ? this.#publicChallenge(current)
      : null;
  }

  async begin(label: string) {
    const existing = this.#vault.enrollment();
    if (existing && existing.expiresAt > Date.now()) {
      return this.#publicChallenge(existing);
    }
    const payload = {
      ...this.#vault.identity(),
      label: z.string().trim().min(1).max(80).parse(label),
    };
    const challenge = relayEnrollmentChallengeSchema.parse(
      await this.#post("/v1/enrollments", payload)
    );
    if (
      challenge.verificationUrl !==
        `${this.#operator.accountOrigin}/enroll/${challenge.enrollmentId}` ||
      challenge.expiresAt <= Date.now() ||
      challenge.expiresAt > Date.now() + 360_000
    ) {
      throw new RemoteConnectionError("relay_rejected");
    }
    this.#vault.saveEnrollment(challenge);
    return this.#publicChallenge(challenge);
  }

  async poll(): Promise<"pending" | "approved" | "complete"> {
    const challenge = this.#vault.enrollment();
    if (!challenge || challenge.expiresAt <= Date.now()) {
      this.#vault.clearEnrollment();
      throw new RemoteConnectionError("enrollment_expired");
    }
    const request = {
      enrollmentId: challenge.enrollmentId,
      pollSecret: challenge.pollSecret,
    };
    const result = relayEnrollmentPollResponseSchema.parse(
      await this.#post("/v1/enrollments/poll", request)
    );
    if (result.status === "pending") {
      return "pending";
    }
    if (result.status === "complete") {
      if (!this.#vault.connection()) {
        throw new RemoteConnectionError("relay_rejected");
      }
      this.#vault.clearEnrollment();
      return "complete";
    }
    const connection = validateRelayConnection(
      result.connection,
      this.#operator,
      this.#vault.identity().hostId
    );
    // Persist before acknowledgement; a lost reply cannot lose the sole copy.
    this.#vault.saveConnection(connection);
    try {
      const ack = relayEnrollmentPollResponseSchema.parse(
        await this.#post("/v1/enrollments/ack", request)
      );
      if (ack.status === "complete") {
        this.#vault.clearEnrollment();
      }
    } catch {
      // Acknowledgement can be retried; the protected credential is durable.
    }
    return "approved";
  }

  async #post(path: string, payload: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.#operator.accountOrigin}${path}`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        signal: this.#signal
          ? AbortSignal.any([this.#signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new RemoteConnectionError("relay_unreachable");
    }
    if (!response.ok) {
      throw new RemoteConnectionError("relay_rejected");
    }
    return response.json();
  }

  #publicChallenge(challenge: z.infer<typeof relayEnrollmentChallengeSchema>) {
    return {
      expiresAt: challenge.expiresAt,
      verificationUrl: challenge.verificationUrl,
      hostId: this.#vault.identity().hostId,
      keyFingerprint: publicKeyHash(this.#vault.identity().publicKey),
    };
  }
}
