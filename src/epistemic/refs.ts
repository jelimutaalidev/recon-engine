import { ENTITY_ID_PREFIXES } from '../domain/helpers.js';

const ENTITY_KEYS = Object.keys(ENTITY_ID_PREFIXES).join('|');

export const ENTITY_REF_PATTERN = new RegExp(`^(?:${ENTITY_KEYS}):.+`);
export const FACT_REF_PATTERN = /^fact:.+/;
export const OBSERVATION_REF_PATTERN = /^obs:.+/;
export const ASSUMPTION_OR_OBSERVATION_REF_PATTERN = /^(?:asm|obs):.+/;
export const EPISTEMIC_REF_PATTERN = /^(?:fact|obs|asm|hyp):.+/;
