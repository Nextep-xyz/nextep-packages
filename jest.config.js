// Suite raíz que BLOQUEA el build (`pnpm test`). Descubre los specs por disco:
//  - governance/gates   : gates de invariantes del repo (público, forma de los paquetes, higiene de excepciones, ...)
//  - packages/<pkg>/test : tests de cada paquete
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/governance/gates/**/*.spec.ts', '<rootDir>/packages/**/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/cdk.out/'],
  // ts-jest (JS puro): el binario nativo de @swc/core lo bloquea Windows App Control en algunas máquinas de desarrollo.
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: true }] },
  moduleNameMapper: {
    '^@governance/(.*)$': '<rootDir>/governance/$1',
    '^@guardrails/(.*)$': '<rootDir>/packages/cdk-guardrails/$1',
    '^@nextep/cdk-guardrails$': '<rootDir>/packages/cdk-guardrails/src/index.ts',
    '^@nextep/gates$': '<rootDir>/packages/gates/src/index.ts',
  },
};
