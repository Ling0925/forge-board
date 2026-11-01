import { randomBytes } from "node:crypto";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RANDOM_BYTES = 10;
const ULID_LENGTH = 26;

export function newId(prefix: string, at: number): string {
  let value =
    (BigInt(at) << BigInt(ULID_RANDOM_BYTES * 8)) |
    BigInt(`0x${randomBytes(ULID_RANDOM_BYTES).toString("hex")}`);
  let result = "";
  for (let index = 0; index < ULID_LENGTH; index++) {
    result =
      ULID_ALPHABET[Number(value % BigInt(ULID_ALPHABET.length))] + result;
    value /= BigInt(ULID_ALPHABET.length);
  }
  return `${prefix}_${result}`;
}
