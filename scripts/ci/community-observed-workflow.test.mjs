import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = path.join(
  repositoryRoot,
  '.github',
  'workflows',
  'community-observed-build.yml',
);
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);
const uiViteSource = readFileSync(
  path.join(repositoryRoot, 'apps', 'browser', 'vite.ui.config.ts'),
  'utf8',
);
const pagesViteSource = readFileSync(
  path.join(repositoryRoot, 'apps', 'browser', 'vite.pages.config.ts'),
  'utf8',
);
const forgeSource = readFileSync(
  path.join(repositoryRoot, 'apps', 'browser', 'forge.config.mts'),
  'utf8',
);
const communityFreePolicySource = readFileSync(
  path.join(
    repositoryRoot,
    'apps',
    'browser',
    'community-free-build-policy.mjs',
  ),
  'utf8',
);

function expression(value) {
  return `\${{ ${value} }}`;
}

function step(jobName, name) {
  const value = workflow.jobs?.[jobName]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(value, `missing ${jobName}/${name}`);
  return value;
}

function visit(value) {
  if (Array.isArray(value)) return value.flatMap(visit);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    { key, value: entry },
    ...visit(entry),
  ]);
}

test('observed community workflow is manual, exact-main and non-promotional', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(
    workflow.on.workflow_dispatch.inputs.confirm.description,
    'Type BUILD_COMMUNITY_OBSERVED to build privacy-safe non-promotional Actions artifacts',
  );
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.build.environment, 'CommunityTelemetry');
  assert.equal(workflow.jobs.preflight.environment, undefined);
  assert.equal(workflow.jobs['source-validation'].environment, undefined);

  const confirmation = step(
    'preflight',
    'Require canonical main and explicit confirmation',
  );
  assert.equal(
    confirmation.env.COMMUNITY_CONFIRMATION,
    expression('inputs.confirm'),
  );
  assert.match(confirmation.run, /BUILD_COMMUNITY_OBSERVED/u);
  assert.match(confirmation.run, /refs\/heads\/main/u);

  const identity = step(
    'preflight',
    'Derive non-tagged observed community build identity',
  ).run;
  assert.match(identity, /-communityobserved\$\{runNumber\}/u);
  assert.doesNotMatch(identity, /git tag|refs\/tags/u);

  for (const jobName of ['preflight', 'source-validation', 'build']) {
    for (const checkout of workflow.jobs[jobName].steps.filter((candidate) =>
      candidate.uses?.startsWith('actions/checkout@'),
    )) {
      assert.equal(checkout.with['fetch-depth'], 1);
      assert.equal(checkout.with['fetch-tags'], false);
      assert.equal(checkout.with['persist-credentials'], false);
    }
  }

  assert.doesNotMatch(
    source,
    /contents:\s*write|id-token:\s*write|attestations:\s*write|gh\s+release|git\s+(?:tag|push)|softprops\/action-gh-release/u,
  );
});

test('observed community workflow fails closed on one environment secret and maps it only to backend build', () => {
  const secretStep = step(
    'build',
    'Require CommunityTelemetry PostHog project key',
  );
  assert.equal(
    secretStep.env.COMMUNITY_POSTHOG_PROJECT_API_KEY,
    expression('secrets.POSTHOG_PROJECT_API_KEY'),
  );
  assert.match(secretStep.run, /\^phc_/u);
  assert.match(secretStep.run, /missing or invalid/u);

  const packageStep = step(
    'build',
    'Build unsigned observed community desktop package',
  );
  assert.equal(
    packageStep.env.POSTHOG_API_KEY,
    expression('secrets.POSTHOG_PROJECT_API_KEY'),
  );

  const secretReferences = source.match(/secrets\.[A-Z0-9_]+/gu) ?? [];
  assert.deepEqual(secretReferences, [
    'secrets.POSTHOG_PROJECT_API_KEY',
    'secrets.POSTHOG_PROJECT_API_KEY',
  ]);
  assert.doesNotMatch(
    source,
    /VITE_POSTHOG|POSTHOG_CLI|POSTHOG_PERSONAL|POSTHOG_PROJECT_API_KEY:\s*phc_/u,
  );
});

test('observed community workflow builds auth-enabled isolated unsigned artifacts and validates privacy metadata', () => {
  assert.equal(
    workflow.jobs.build.env.CLODEX_DISTRIBUTION_MODE,
    'community-observed',
  );
  assert.equal(workflow.jobs.build.env.CLODEX_AUTH_ENABLED, 'true');
  assert.equal(workflow.jobs.build.env.RELEASE_CHANNEL, 'release');
  assert.equal(workflow.jobs.build.env.VITE_DISABLE_TELEMETRY, 'true');
  assert.equal(workflow.jobs.build.strategy.matrix.include.length, 4);

  const validation = step(
    'build',
    'Validate exact observed community desktop artifacts',
  ).run;
  assert.match(validation, /--distribution-mode=community-observed/u);
  assert.match(validation, /release:validate:macos/u);
  assert.match(validation, /release:validate:artifacts/u);

  const packagedBoundary = step(
    'build',
    'Enforce packaged Community Free byte boundary',
  );
  assert.match(packagedBoundary.run, /community:packaged-boundary:validate/u);
  assert.match(packagedBoundary.run, /--distribution-mode=community-observed/u);
  assert.match(
    packagedBoundary.run,
    /--validation-manifest=\$validation_manifest/u,
  );
  assert.match(
    packagedBoundary.run,
    /validation_manifest="\$GITHUB_WORKSPACE\/apps\/browser\/out\/community-observed\/validation\/\$\{COMMUNITY_PLATFORM\}-\$\{COMMUNITY_ARCH\}-\$\{COMMUNITY_VERSION\}\.json"/u,
  );

  const assemblerStep = step(
    'build',
    'Assemble bounded observed community bundle',
  );
  const assembler = assemblerStep.run;
  assert.match(
    assembler,
    /validation_manifest="\$GITHUB_WORKSPACE\/apps\/browser\/out\/community-observed\/validation\//u,
  );
  assert.match(assembler, /assemble-community-observed-bundle\.mjs/u);

  const upload = step('build', 'Upload observed community Actions artifact');
  assert.match(upload.with.name, /^clodex-community-observed-/u);
  assert.equal(upload.with['retention-days'], 14);
  assert.equal(upload.with['if-no-files-found'], 'error');
  const buildSteps = workflow.jobs.build.steps;
  assert.ok(
    buildSteps.indexOf(
      step('build', 'Validate exact observed community desktop artifacts'),
    ) < buildSteps.indexOf(packagedBoundary),
  );
  assert.ok(
    buildSteps.indexOf(packagedBoundary) < buildSteps.indexOf(assemblerStep),
  );
  assert.ok(buildSteps.indexOf(assemblerStep) < buildSteps.indexOf(upload));

  for (const action of visit(workflow)
    .filter((entry) => entry.key === 'uses')
    .map((entry) => entry.value)) {
    assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
  }
});

test('desktop protocol packaging remains gated by distribution policy', () => {
  assert.match(
    forgeSource,
    /\.\.\.\(buildConstants\.__APP_REGISTER_DEFAULT_PROTOCOLS__\s*\?\s*\{[\s\S]*?protocols:\s*\[[\s\S]*?schemes:\s*desktopProtocolSchemes/u,
  );
});

test('observed backend hard-enables auth with a non-overridable client identity', () => {
  assert.match(
    communityFreePolicySource,
    /CLODEX_IDE_CLIENT_ID:\s*observed\s*\?\s*'clodex-community-observed'/u,
  );
  assert.match(
    communityFreePolicySource,
    /CLODEX_AUTH_ENABLED:\s*observed\s*\?\s*'true'/u,
  );
});

test('all renderer builds replace PostHog with observed no-op modules', () => {
  const expectedAliases = [
    ['@ui/hooks/use-posthog', './src/ui/telemetry/posthog-react-noop.tsx'],
    ['posthog-js/react', './src/ui/telemetry/posthog-react-noop.tsx'],
    ['posthog-js', './src/ui/telemetry/posthog-noop.ts'],
  ];
  for (const [label, configSource] of [
    ['main window', uiViteSource],
    ['pages', pagesViteSource],
  ]) {
    const observedBlocks = [
      ...configSource.matchAll(
        /\.\.\.\(buildConstants\.__APP_DISTRIBUTION_MODE__\s*===\s*'community-observed'\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{\}\),/gu,
      ),
    ];
    assert.equal(observedBlocks.length, 1, label);
    const observedBlock = observedBlocks[0];
    const aliases = [
      ...(observedBlock[1] ?? '').matchAll(
        /'([^']+)'\s*:\s*path\.resolve\(\s*__dirname,\s*'([^']+)'\s*,?\s*\)/gu,
      ),
    ].map((match) => [match[1], match[2]]);
    assert.deepEqual(aliases, expectedAliases, label);

    const observedBlockStart = observedBlock.index;
    assert.notEqual(observedBlockStart, undefined, label);
    const observedBlockEnd =
      (observedBlockStart ?? 0) + observedBlock[0].length;
    const generalUiAlias = configSource.indexOf("'@ui':", observedBlockEnd);
    assert.ok(
      generalUiAlias > observedBlockEnd,
      `${label}: observed aliases must precede the general @ui alias`,
    );
  }
});
