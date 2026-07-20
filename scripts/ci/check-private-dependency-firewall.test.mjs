import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkPrivateDependencyFirewall } from './check-private-dependency-firewall.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clodex-private-boundary-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const policy = {
    schemaVersion: 1,
    status: 'REFERENCE_POLICY_UNAPPROVED',
    gatewayImplementationAuthorized: false,
    allowedPublishedPackages: [],
    approvedGeneratedInputs: [],
    forbiddenFileSha256: [],
    ...options.policy,
  };
  writeFileSync(
    join(root, '.clodex-boundary-policy.json'),
    JSON.stringify(policy, null, 2) + '\n',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'synthetic-boundary-fixture',
        private: true,
        dependencies: {
          zod: '3.25.76',
        },
        ...options.packageJson,
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, 'src', 'index.ts'),
    options.source ?? 'export const synthetic = true;\n',
  );
  return root;
}

test('accepts a dependency-safe synthetic private baseline', () => {
  const root = fixture();
  assert.deepEqual(checkPrivateDependencyFirewall(root), []);
});

test('rejects CLODEx and Stagewise implementation packages', () => {
  const root = fixture({
    packageJson: {
      dependencies: {
        '@clodex/agent-shell': '0.0.0',
        '@stagewise/karton': '1.0.0',
      },
    },
  });
  const errors = checkPrivateDependencyFirewall(root);
  assert.equal(
    errors.filter((error) => /forbidden implementation package/u.test(error))
      .length,
    2,
  );
});

test('rejects workspace, file, link, URL, Git, patch, and forbidden aliases', () => {
  const root = fixture({
    packageJson: {
      dependencies: {
        alpha: 'workspace:*',
        beta: 'file:../public',
        gamma: 'link:../public',
        delta: 'https://example.invalid/archive.tgz',
        epsilon: 'git+https://example.invalid/repository.git',
        zeta: 'patch:zeta@1.0.0#patches/zeta.patch',
        eta: 'npm:@clodex/agent-core@0.0.0',
        theta: 'ssh://git@example.invalid/repository.git',
        iota: 'git@example.invalid:repository.git',
        kappa: '../public-package',
        lambda: 'catalog:default',
      },
    },
  });
  const errors = checkPrivateDependencyFirewall(root);
  for (const dependency of [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
    'kappa',
    'lambda',
  ]) {
    assert.ok(
      errors.some((error) => error.includes('.' + dependency + ':')),
      'missing rejection for ' + dependency + ': ' + errors.join(' | '),
    );
  }
  assert.ok(errors.some((error) => /alias targets a forbidden/u.test(error)));
});

test('rejects forbidden source dependencies', () => {
  const root = fixture({
    source:
      "import '@clodex/runner-sdk';\nimport '@stagewise/karton';\nexport {};\n",
  });
  const errors = checkPrivateDependencyFirewall(root);
  assert.equal(
    errors.filter((error) => /forbidden source dependency/u.test(error)).length,
    2,
  );
});

test('rejects restricted paths and synthetic secret material', () => {
  const secret = 'sk-' + 'A'.repeat(24);
  const root = fixture({
    source:
      "export const path = 'CLODEx_Private_Data_Room';\n" +
      "export const token = '" +
      secret +
      "';\n",
  });
  const errors = checkPrivateDependencyFirewall(root);
  assert.ok(
    errors.some((error) => /restricted\/private material marker/u.test(error)),
  );
  assert.ok(errors.some((error) => /OpenAI-style secret key/u.test(error)));
});

test('rejects unreviewed generated inputs and accepts exact approved bytes', () => {
  const generated = '// @generated\nexport const value = 1;\n';
  const root = fixture({ source: generated });
  let errors = checkPrivateDependencyFirewall(root);
  assert.ok(
    errors.some((error) => /generated input is unreviewed/u.test(error)),
  );

  const policyPath = join(root, '.clodex-boundary-policy.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.approvedGeneratedInputs = [
    {
      path: 'src/index.ts',
      sha256: sha256(generated),
      generator: 'synthetic-test-generator',
      inputProvenance: 'synthetic-only',
    },
  ];
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n');
  errors = checkPrivateDependencyFirewall(root);
  assert.deepEqual(errors, []);
});

test('rejects an exact copied-source fingerprint', () => {
  const copied = 'export const distinctiveSyntheticSentinel = 17;\n';
  const root = fixture({
    policy: {
      forbiddenFileSha256: [
        {
          source: 'public/synthetic-sentinel.ts',
          sha256: sha256(copied),
        },
      ],
    },
    source: copied,
  });
  const errors = checkPrivateDependencyFirewall(root);
  assert.ok(
    errors.some((error) => /exact copied-source fingerprint/u.test(error)),
  );
});

test('keeps approved protocol packages empty until external gates close', () => {
  const root = fixture({
    policy: {
      allowedPublishedPackages: ['@clodex/protocol'],
    },
  });
  const errors = checkPrivateDependencyFirewall(root);
  assert.ok(
    errors.some((error) =>
      /no published Protocol v0 or SDK package is approved/u.test(error),
    ),
  );
});
