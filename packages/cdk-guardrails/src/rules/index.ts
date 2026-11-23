// Registro del catálogo. Un archivo nuevo en src/rules/NX-*.ts que no aparezca aquí hace fallar el gate GR1
// (governance/gates/guardrails-rules.spec.ts descubre las reglas por disco y compara con esta lista).
import type { Rule } from '../types';
import { rule as NX_BKP_001 } from './NX-BKP-001';
import { rule as NX_BKP_002 } from './NX-BKP-002';
import { rule as NX_COST_001 } from './NX-COST-001';
import { rule as NX_COST_002 } from './NX-COST-002';
import { rule as NX_COST_003 } from './NX-COST-003';
import { rule as NX_ECS_001 } from './NX-ECS-001';
import { rule as NX_FIN_001 } from './NX-FIN-001';
import { rule as NX_LOG_001 } from './NX-LOG-001';
import { rule as NX_POWER_001 } from './NX-POWER-001';
import { rule as NX_POWER_002 } from './NX-POWER-002';
import { rule as NX_POWER_003 } from './NX-POWER-003';
import { rule as NX_POWER_004 } from './NX-POWER-004';
import { rule as NX_POWER_005 } from './NX-POWER-005';
import { rule as NX_PROT_001 } from './NX-PROT-001';
import { rule as NX_S3_001 } from './NX-S3-001';
import { rule as NX_ALM_001 } from './NX-ALM-001';
import { rule as NX_WAF_001 } from './NX-WAF-001';
import { rule as NX_WAF_002 } from './NX-WAF-002';

export const ALL_RULES: readonly Rule[] = [NX_FIN_001, NX_COST_001, NX_COST_002, NX_COST_003, NX_POWER_001, NX_POWER_002, NX_POWER_003, NX_POWER_004, NX_POWER_005, NX_ECS_001, NX_PROT_001, NX_S3_001, NX_BKP_001, NX_BKP_002, NX_WAF_001, NX_WAF_002, NX_ALM_001, NX_LOG_001];
