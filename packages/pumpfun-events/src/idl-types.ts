/** Subset of the Anchor IDL shape that the generated schema carries. */

export type IdlType =
  | string
  | { vec: IdlType }
  | { option: IdlType }
  | { array: [IdlType, number] }
  | { defined: { name: string } };

export interface IdlField {
  name: string;
  type: IdlType;
}

export type IdlTypeDef =
  | { kind: 'struct'; fields?: IdlField[] | IdlType[] }
  | { kind: 'enum'; variants: { name: string; fields?: IdlField[] | IdlType[] }[] };

export interface IdlEventSchema {
  name: string;
  /** 8-byte Anchor discriminator, hex. */
  discriminator: string;
  fields: IdlField[];
}

export interface IdlAccountSchema {
  name: string;
  writable: boolean;
  signer: boolean;
  address?: string;
  pda?: {
    seeds: IdlSeed[];
    program?: IdlSeed;
  };
  optional?: boolean;
}

export type IdlSeed =
  | { kind: 'const'; value: number[] }
  | { kind: 'account'; path: string; account?: string }
  | { kind: 'arg'; path: string };

export interface IdlInstructionSchema {
  name: string;
  discriminator: string;
  accounts: IdlAccountSchema[];
  args: IdlField[];
}

/** Account layouts share the event shape: discriminator + ordered fields. */
export type IdlAccountLayoutSchema = IdlEventSchema;

export interface IdlProgramSchema {
  address: string;
  events: IdlEventSchema[];
  accounts: IdlAccountLayoutSchema[];
  types: Record<string, IdlTypeDef>;
  instructions: IdlInstructionSchema[];
}
