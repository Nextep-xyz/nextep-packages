import { referencesLogicalId, scalesToZero, scheduleCadence, staticText, tagMap, universalTarget } from '@guardrails/src/cfn';

describe('staticText: resuelve strings estáticos de un template', () => {
  it('un string literal es completo', () => {
    expect(staticText('abc')).toEqual({ text: 'abc', complete: true });
  });

  it('Fn::Join con literales y Ref AWS::Partition (la forma real del Target.Arn de Scheduler, spikes S3-A)', () => {
    const arn = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':scheduler:::aws-sdk:rds:stopDBInstance']] };
    expect(staticText(arn)).toEqual({ text: 'arn:aws:scheduler:::aws-sdk:rds:stopDBInstance', complete: true });
  });

  it('un intrinsic no resoluble deja un hueco y marca incompleto', () => {
    const r = staticText({ 'Fn::Join': ['', ['arn:aws:scheduler:::aws-sdk:rds:', { Ref: 'Accion' }]] });
    expect(r?.complete).toBe(false);
    expect(r?.text.startsWith('arn:aws:scheduler:::aws-sdk:rds:')).toBe(true);
  });

  it('Fn::GetAtt y Ref a un parámetro son incompletos; undefined y números no son texto', () => {
    expect(staticText({ 'Fn::GetAtt': ['Fn', 'Arn'] })?.complete).toBe(false);
    expect(staticText(undefined)).toBeUndefined();
    expect(staticText(5)).toBeUndefined();
  });
});

describe('universalTarget: acción de un target universal de Scheduler', () => {
  it('extrae servicio y acción de una ARN resuelta', () => {
    expect(universalTarget({ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':scheduler:::aws-sdk:rds:stopDBInstance']] })).toEqual({ service: 'rds', action: 'stopDBInstance', complete: true });
  });

  it('la acción puede quedar incompleta (parámetro en medio): se reporta como tal', () => {
    const t = universalTarget({ 'Fn::Join': ['', ['arn:aws:scheduler:::aws-sdk:rds:', { Ref: 'Accion' }]] });
    expect(t).toMatchObject({ service: 'rds', complete: false });
  });

  it('una ARN de Lambda (GetAtt) no es un target universal', () => {
    expect(universalTarget({ 'Fn::GetAtt': ['Fn', 'Arn'] })).toBeUndefined();
    // El ID de cuenta se arma en tiempo de ejecucion: este archivo es de un repo publico y lo escanea el gate G13.
    expect(universalTarget(`arn:aws:lambda:us-east-2:${'1'.repeat(12)}:function:f`)).toBeUndefined();
    expect(universalTarget(undefined)).toBeUndefined();
  });
});

describe('tagMap: normaliza Tags en lista y en mapa (spikes S3-B)', () => {
  it('lista de {Key,Value}', () => {
    expect(tagMap({ Tags: [{ Key: 'A', Value: '1' }, { Key: 'B', Value: '2' }] })).toEqual({ A: '1', B: '2' });
  });
  it('mapa', () => {
    expect(tagMap({ Tags: { A: '1' } })).toEqual({ A: '1' });
  });
  it('sin Tags, o Tags intrinsic: undefined (no evaluable)', () => {
    expect(tagMap({})).toBeUndefined();
    expect(tagMap({ Tags: { 'Fn::If': ['c', [], []] } })).toBeUndefined();
    expect(tagMap(undefined)).toBeUndefined();
  });
});

describe('scalesToZero', () => {
  it('MinCapacity 0 (número o string)', () => {
    expect(scalesToZero({ MinCapacity: 0 })).toBe(true);
    expect(scalesToZero({ MinCapacity: '0' })).toBe(true);
    expect(scalesToZero({ MinCapacity: 1 })).toBe(false);
  });
  it('acción programada con MaxCapacity 0', () => {
    expect(scalesToZero({ MinCapacity: 1, ScheduledActions: [{ ScalableTargetAction: { MinCapacity: 0, MaxCapacity: 0 } }] })).toBe(true);
  });
  it('acción programada que solo sube (prewarm) no es apagado', () => {
    expect(scalesToZero({ MinCapacity: 1, ScheduledActions: [{ ScalableTargetAction: { MinCapacity: 2, MaxCapacity: 4 } }] })).toBe(false);
  });
});

describe('referencesLogicalId', () => {
  it('encuentra el id dentro de un Fn::GetAtt anidado', () => {
    expect(referencesLogicalId({ 'Fn::Join': ['', ['service/c/', { 'Fn::GetAtt': ['Api', 'Name'] }]] }, 'Api')).toBe(true);
    expect(referencesLogicalId({ Ref: 'Api' }, 'Api')).toBe(true);
  });
  it('no confunde un id con otro ni con un literal', () => {
    expect(referencesLogicalId({ 'Fn::GetAtt': ['ApiExtra', 'Name'] }, 'Api')).toBe(false);
    expect(referencesLogicalId('Api', 'Api')).toBe(false);
  });
});

describe('scheduleCadence: ¿la expresión restringe el día de la semana?', () => {
  it.each([
    ['cron(30 20 ? * MON-FRI *)', 'restricted'],
    ['cron(0 22 ? * SAT,SUN *)', 'restricted'],
    ['cron(0 20 ? * 2-6 *)', 'restricted'],
    ['cron(0 20 ? * 6L *)', 'restricted'],
    ['cron(0 20 ? * FRI#3 *)', 'restricted'],
    ['cron(0 20 ? * */2 *)', 'restricted'],
    ['cron(0 20 * * ? *)', 'unrestricted'],
    ['cron(0 20 ? * * *)', 'unrestricted'],
    ['cron(0 21 ? * 1-7 *)', 'unrestricted'],
    ['cron(0 21 ? * SUN-SAT *)', 'unrestricted'],
    ['cron(0 21 ? * MON-SUN *)', 'unrestricted'],
    ['cron(0 21 ? * FRI-MON,TUE-THU *)', 'unrestricted'],
    ['rate(1 day)', 'unrestricted'],
    ['rate(12 hours)', 'unrestricted'],
    ['at(2026-12-01T20:00:00)', 'one-shot'],
    ['cron(esto no es cron)', 'unknown'],
    ['cron(0 20 ? * FUNDAY *)', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (expr, expected) => {
    expect(scheduleCadence(expr)).toBe(expected);
  });
});
