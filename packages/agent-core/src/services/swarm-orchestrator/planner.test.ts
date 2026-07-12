import { describe, expect, it } from 'vitest';
import {
  buildTriagePrompt,
  createBattleSwarmPlan,
  createFallbackSwarmPlan,
  estimateTaskComplexity,
  parseTriageResult,
} from './planner';

describe('swarm orchestrator planner', () => {
  it('builds a strict JSON triage prompt that includes the user prompt', () => {
    const prompt = buildTriagePrompt('implement provider routing');

    expect(prompt).toContain('Respond with JSON only.');
    expect(prompt).toContain(
      '<user_prompt>implement provider routing</user_prompt>',
    );
    expect(prompt).toContain(
      'Allowed task roles: researcher, planner, coder, reviewer.',
    );
    expect(prompt).toContain('Optional task modelTaskRole values');
    expect(prompt).toContain('DEBATE SWARM RULE');
    expect(prompt).toContain('a minimalist strategist');
    expect(prompt).toContain('Then add an arbiter/planner phase');
    expect(prompt).toContain('CRITICAL LANGUAGE RULE');
    expect(prompt).toContain('same natural language as the user prompt');
  });

  it('parses direct low-complexity triage results', () => {
    expect(
      parseTriageResult({
        type: 'direct',
        task_complexity: 'low',
        reason: 'Small one-file edit.',
      }),
    ).toEqual({
      type: 'direct',
      taskComplexity: 'low',
      reason: 'Small one-file edit.',
    });
  });

  it('parses JSON-string triage responses from models', () => {
    expect(
      parseTriageResult(
        '```json\n{"type":"direct","task_complexity":"low","reason":"Small."}\n```',
      ),
    ).toEqual({
      type: 'direct',
      taskComplexity: 'low',
      reason: 'Small.',
    });
  });

  it('extracts JSON from prose-prefixed triage responses', () => {
    expect(
      parseTriageResult(
        'Вот JSON-план:\n{"type":"direct","task_complexity":"low","reason":"Мелкая задача."}',
      ),
    ).toEqual({
      type: 'direct',
      taskComplexity: 'low',
      reason: 'Мелкая задача.',
    });
  });

  it('parses and normalizes swarm triage plans', () => {
    const result = parseTriageResult({
      type: 'swarm',
      task_complexity: 'high',
      workflow: {
        description: 'Refactor auth',
        phases: [
          {
            id: 'p1',
            title: 'Discovery',
            tasks: [
              {
                name: 'Scanner',
                role: 'researcher',
                prompt: 'Find auth code',
              },
            ],
          },
        ],
      },
    });

    expect(result.type).toBe('swarm');
    if (result.type !== 'swarm') throw new Error('Expected swarm result');
    expect(result.plan.workflow.phases[0]?.tasks[0]?.id).toBe('p1-t1');
  });

  it('estimates obvious low, medium, and high complexity prompts', () => {
    expect(estimateTaskComplexity('fix typo')).toBe('low');
    expect(
      estimateTaskComplexity('implement provider settings integration'),
    ).toBe('medium');
    expect(estimateTaskComplexity('security audit the whole project')).toBe(
      'high',
    );
  });

  it('creates deterministic fallback plans for high-complexity tasks', () => {
    const plan = createFallbackSwarmPlan('migrate auth architecture', 'high');

    expect(plan.task_complexity).toBe('high');
    expect(plan.workflow.phases.map((phase) => phase.id)).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
    ]);
    expect(plan.workflow.phases[1]?.title).toBe('Strategy Debate');
    expect(plan.workflow.phases[1]?.tasks.map((task) => task.name)).toEqual([
      'Minimalist',
      'Builder',
      'Skeptic',
    ]);
    expect(
      plan.workflow.phases[1]?.tasks.map((task) => task.modelTaskRole),
    ).toEqual(['analysis', 'analysis', 'analysis']);
    expect(plan.workflow.phases[1]?.tasks.map((task) => task.role)).toEqual([
      'planner',
      'planner',
      'planner',
    ]);
    expect(
      plan.workflow.phases[1]?.tasks.map((task) => task.preferredModelId),
    ).toEqual(['gpt-5.5', 'claude-opus-4.8', 'gemini-3.5-flash']);
    expect(plan.workflow.phases[0]?.tasks[0]?.preferredModelId).toBe('gpt-5.5');
    expect(plan.workflow.phases[2]?.tasks[0]?.preferredModelId).toBe('gpt-5.5');
    expect(plan.workflow.phases[4]?.tasks[0]?.preferredModelId).toBe('gpt-5.5');
    expect(plan.workflow.phases[2]?.title).toBe('Arbiter Decision');
    expect(plan.workflow.phases[2]?.tasks[0]?.name).toBe('Arbiter');
    expect(plan.workflow.phases[3]?.tasks.map((task) => task.role)).toEqual([
      'coder',
      'coder',
    ]);
  });

  it('localizes fallback plans for Russian prompts', () => {
    const plan = createFallbackSwarmPlan(
      'сделай аудит безопасности авторизации',
      'high',
    );

    expect(plan.workflow.description).toContain('Агентский workflow');
    expect(plan.workflow.phases.map((phase) => phase.title)).toEqual([
      'Анализ структуры и AST-карта',
      'Батл стратегий',
      'Решение арбитра',
      'Параллельная реализация',
      'Ревью и проверка',
    ]);
    expect(plan.workflow.phases[0]?.tasks[0]?.name).toBe('Сканер');
    expect(plan.workflow.phases[1]?.tasks.map((task) => task.name)).toEqual([
      'Минималист',
      'Строитель',
      'Скептик',
    ]);
    expect(plan.workflow.phases[2]?.tasks[0]?.name).toBe('Арбитр');
    expect(plan.workflow.phases[4]?.tasks[0]?.name).toBe('Ревьюер');
  });

  it('creates a Battle Agent fan-out/fan-in plan without a serial scanner gate', () => {
    const plan = createBattleSwarmPlan('audit model routing');

    expect(plan.task_complexity).toBe('high');
    expect(plan.workflow.phases.map((phase) => phase.title)).toEqual([
      'Round 1: Independent Analysis',
      'Round 2: Rebuttals',
      'Synthesizer: Gemini 3.5',
    ]);
    expect(plan.workflow.phases[0]?.failureMode).toBe('soft');
    expect(plan.workflow.phases[1]?.failureMode).toBe('soft');
    expect(plan.workflow.phases[0]?.tasks.map((task) => task.name)).toEqual([
      'GPT-5.5 Pragmatist',
      'Opus 4.8 Architect',
    ]);
    expect(
      plan.workflow.phases[0]?.tasks.map((task) => task.preferredModelId),
    ).toEqual(['gpt-5.5', 'claude-opus-4.8']);
    expect(plan.workflow.phases[0]?.tasks.map((task) => task.role)).toEqual([
      'planner',
      'planner',
    ]);
    expect(plan.workflow.phases[1]?.tasks).toHaveLength(2);
    expect(plan.workflow.phases[2]?.tasks).toHaveLength(1);
    expect(plan.workflow.phases[2]?.tasks[0]?.name).toBe(
      'Gemini 3.5 Synthesizer',
    );
    expect(plan.workflow.phases[2]?.tasks[0]?.preferredModelId).toBe(
      'gemini-3.5-flash',
    );
    expect(plan.workflow.phases[2]?.tasks[0]?.prompt).toContain(
      'Do not wait for consensus',
    );
    expect(plan.workflow.phases.flatMap((phase) => phase.tasks)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Scanner' })]),
    );
  });
});
