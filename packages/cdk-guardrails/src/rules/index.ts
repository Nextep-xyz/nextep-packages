// Registro del catálogo. Un archivo nuevo en src/rules/NX-*.ts que no aparezca aquí hace fallar el gate GR1
// (governance/gates/guardrails-rules.spec.ts descubre las reglas por disco y compara con esta lista).
import type { Rule } from '../types';
import { rule as NX_COST_001 } from './NX-COST-001';
import { rule as NX_COST_002 } from './NX-COST-002';
import { rule as NX_COST_003 } from './NX-COST-003';
import { rule as NX_FIN_001 } from './NX-FIN-001';
import { rule as NX_POWER_001 } from './NX-POWER-001';
import { rule as NX_POWER_002 } from './NX-POWER-002';
import { rule as NX_POWER_003 } from './NX-POWER-003';
import { rule as NX_POWER_004 } from './NX-POWER-004';

export const ALL_RULES: readonly Rule[] = [NX_FIN_001, NX_COST_001, NX_COST_002, NX_COST_003, NX_POWER_001, NX_POWER_002, NX_POWER_003, NX_POWER_004];
