import {
  type DynamicTriageResult,
  type RawTriageResult,
  type SwarmPlan,
  type TaskComplexity,
  triageResultSchema,
} from './types';

export function buildTriagePrompt(userPrompt: string): string {
  return [
    'You are a senior software architect inside Clodex IDE.',
    'Evaluate the user request and decide whether it should run directly or through a multi-agent swarm workflow.',
    '',
    'Complexity labels:',
    '- low: small edits, typos, one or two files, or a simple question. Return {"type":"direct","task_complexity":"low"}.',
    '- medium: a feature, function-level refactor, or about 3-5 files. Return a swarm plan.',
    '- high: global refactor, architecture changes, security audit, migration, or unknown scope. Return a swarm plan.',
    '',
    'For swarm plans, return strict JSON with this shape:',
    '{',
    '  "type": "swarm",',
    '  "task_complexity": "medium" | "high",',
    '  "workflow": {',
    '    "description": "short workflow summary",',
    '    "phases": [',
    '      {',
    '        "id": "p1",',
    '        "title": "Discovery & AST Mapping",',
    '        "tasks": [',
    '          { "name": "Scanner", "role": "researcher", "modelTaskRole": "analysis", "prompt": "specific task prompt" }',
    '        ]',
    '      }',
    '    ]',
    '  }',
    '}',
    '',
    'Allowed task roles: researcher, planner, coder, reviewer.',
    'Optional task modelTaskRole values: analysis, coding, review.',
    'Role boundaries:',
    '- researcher: inspect the codebase and find concrete files/symbols; do not write code.',
    '- planner: turn discovery into a concrete implementation plan; do not write code.',
    '- coder: implement the plan with write/multiEdit-capable tasks.',
    '- reviewer: inspect produced changes and report PASS or blocking defects.',
    '',
    'DEBATE SWARM RULE:',
    'For medium and high tasks, include a strategy debate before implementation unless the task is urgent and trivial.',
    'The debate MUST be one parallel analysis phase with three independent model participants:',
    '- a minimalist strategist (planner, modelTaskRole analysis) argues for the smallest safe approach;',
    '- a builder strategist (planner, modelTaskRole analysis) argues for the most robust implementation approach;',
    '- a skeptic (planner, modelTaskRole analysis) attacks both approaches and lists failure modes.',
    'All debate participants analyze only. They must not write files, and they must start in the same phase so they can run concurrently.',
    'Then add an arbiter/planner phase that reads the debate and chooses the final implementation plan for coders.',
    '',
    'CRITICAL LANGUAGE RULE:',
    'The UI-visible fields workflow.description, phases[].title, tasks[].name, and tasks[].prompt MUST be written in the same natural language as the user prompt.',
    'If the user prompt is in Russian, write those fields in Russian, for example: "Анализ структуры", "Планирование", "Реализация", "Ревью".',
    'Keep JSON keys and enum values in English exactly as specified.',
    'Respond with JSON only.',
    '',
    `<user_prompt>${userPrompt}</user_prompt>`,
  ].join('\n');
}

export function parseTriageResult(value: unknown): DynamicTriageResult {
  const parsed = triageResultSchema.parse(
    normalizeTriageValue(value),
  ) as RawTriageResult;

  if ('type' in parsed && parsed.type === 'direct') {
    return {
      type: 'direct',
      taskComplexity: 'low',
      reason: parsed.reason,
    };
  }

  return {
    type: 'swarm',
    taskComplexity: parsed.task_complexity,
    plan: normalizeSwarmPlan(parsed),
  };
}

function normalizeTriageValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced?.[1]?.trim() ?? extractJsonObject(trimmed);
  return JSON.parse(jsonText);
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return text;
  return text.slice(start, end + 1);
}

export function normalizeSwarmPlan(plan: SwarmPlan): SwarmPlan {
  return {
    task_complexity: plan.task_complexity,
    workflow: {
      description: plan.workflow.description,
      phases: plan.workflow.phases.map((phase, phaseIndex) => ({
        ...phase,
        id: phase.id || `p${phaseIndex + 1}`,
        tasks: phase.tasks.map((task, taskIndex) => ({
          ...task,
          id:
            task.id || `${phase.id || `p${phaseIndex + 1}`}-t${taskIndex + 1}`,
        })),
      })),
    },
  };
}

export function estimateTaskComplexity(userPrompt: string): TaskComplexity {
  const text = userPrompt.trim().toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (
    /\b(security|audit|architecture|migration|global|whole project|entire project|multi[-\s]?agent|swarm|ultracode)\b/.test(
      text,
    ) ||
    /глобальн|архитектур|аудит|безопасност|миграц|ро[йя]/i.test(text)
  ) {
    return 'high';
  }

  if (
    wordCount > 80 ||
    /\b(feature|refactor|implement|integration|workflow|endpoint|settings|provider)\b/.test(
      text,
    ) ||
    /фич|рефактор|интеграц|эндпоинт|провайдер|настройк|внедр/i.test(text)
  ) {
    return 'medium';
  }

  return 'low';
}

function isLikelyRussian(text: string): boolean {
  return /[а-яё]/i.test(text);
}

export function createFallbackSwarmPlan(
  userPrompt: string,
  complexity: Exclude<TaskComplexity, 'low'> = 'medium',
): SwarmPlan {
  const basePrompt = userPrompt.trim();
  const russian = isLikelyRussian(basePrompt);
  const labels = russian
    ? {
        description: `Агентский workflow для: ${basePrompt}`,
        discoveryHigh: 'Анализ структуры и AST-карта',
        discovery: 'Анализ',
        architecture: 'Архитектура и план',
        implementationHigh: 'Параллельная реализация',
        implementation: 'Реализация',
        review: 'Ревью и проверка',
        scanner: 'Сканер',
        architect: 'Архитектор',
        coder: 'Кодер',
        coderCore: 'Кодер-Core',
        coderUi: 'Кодер-UI',
        reviewer: 'Ревьюер',
        debate: 'Батл стратегий',
        arbitration: 'Решение арбитра',
        minimalist: 'Минималист',
        builder: 'Строитель',
        skeptic: 'Скептик',
        arbiter: 'Арбитр',
        gptModel: 'GPT-5.5',
        opusModel: 'Opus 4.8',
        geminiModel: 'Gemini 3.5 Flash',
        corePrompt: `Реализуй core/backend-изменения для: ${basePrompt}`,
        uiPrompt: `Реализуй UI/integration-изменения для: ${basePrompt}`,
        safePrompt: `Реализуй минимальное безопасное изменение для: ${basePrompt}`,
        highDiscoveryPrompt: `Найди релевантные файлы, символы, API и ограничения для: ${basePrompt}`,
        mediumDiscoveryPrompt: `Найди релевантные файлы и символы для: ${basePrompt}`,
        architecturePrompt: `Составь краткий план реализации на основе анализа для: ${basePrompt}`,
        minimalistPrompt: `Ты представляешь GPT-5.5 в модельном батле. Защити минимальный безопасный подход для: ${basePrompt}. Спорь с лишней сложностью, перечисли самый короткий путь, риски и что точно не стоит трогать.`,
        builderPrompt: `Ты представляешь Opus 4.8 в модельном батле. Защити более robust/архитектурный подход для: ${basePrompt}. Спорь с минималистом, если его подход создает техдолг, и предложи масштабируемую реализацию.`,
        skepticPrompt: `Ты представляешь Gemini 3.5 Flash в модельном батле. Выступи строгим оппонентом для: ${basePrompt}. Атакуй оба возможных подхода, найди failure modes, edge cases, security/type risks и вопросы, которые арбитр должен решить.`,
        arbiterPrompt: `Прочитай батл стратегов и скептика для: ${basePrompt}. Выбери финальный подход, объясни почему, зафиксируй файлы/символы для изменения и дай четкие инструкции кодерам.`,
        highReviewPrompt: `Проверь реализацию, найди риски и предложи минимальную релевантную проверку для: ${basePrompt}`,
        mediumReviewPrompt: `Проверь изменения и предложи проверку для: ${basePrompt}`,
      }
    : {
        description: `Swarm workflow for: ${basePrompt}`,
        discoveryHigh: 'Discovery & AST Mapping',
        discovery: 'Discovery',
        architecture: 'Architecture & Planning',
        implementationHigh: 'Parallel Implementation',
        implementation: 'Implementation',
        review: 'Review & Verification',
        scanner: 'Scanner',
        architect: 'Architect',
        coder: 'Coder',
        coderCore: 'Coder-Core',
        coderUi: 'Coder-UI',
        reviewer: 'Reviewer',
        debate: 'Strategy Debate',
        arbitration: 'Arbiter Decision',
        minimalist: 'Minimalist',
        builder: 'Builder',
        skeptic: 'Skeptic',
        arbiter: 'Arbiter',
        gptModel: 'GPT-5.5',
        opusModel: 'Opus 4.8',
        geminiModel: 'Gemini 3.5 Flash',
        corePrompt: `Implement the core/backend changes for: ${basePrompt}`,
        uiPrompt: `Implement the UI/integration changes for: ${basePrompt}`,
        safePrompt: `Implement the smallest safe change for: ${basePrompt}`,
        highDiscoveryPrompt: `Find the relevant files, symbols, APIs, and constraints for: ${basePrompt}`,
        mediumDiscoveryPrompt: `Locate the relevant files and symbols for: ${basePrompt}`,
        architecturePrompt: `Draft a concise implementation plan using the discovery context for: ${basePrompt}`,
        minimalistPrompt: `You represent GPT-5.5 in the model battle. Defend the smallest safe approach for: ${basePrompt}. Argue against unnecessary complexity, list the shortest path, risks, and what should not be touched.`,
        builderPrompt: `You represent Opus 4.8 in the model battle. Defend the more robust architectural approach for: ${basePrompt}. Push back on the minimalist if that path creates debt, and propose a scalable implementation.`,
        skepticPrompt: `You represent Gemini 3.5 Flash in the model battle. Act as a strict opponent for: ${basePrompt}. Attack both likely approaches, identify failure modes, edge cases, security/type risks, and questions the arbiter must settle.`,
        arbiterPrompt: `Read the strategist and skeptic debate for: ${basePrompt}. Choose the final approach, explain why, name the files/symbols to change, and give coder-ready instructions.`,
        highReviewPrompt: `Review the implementation, identify risks, and propose the smallest relevant verification for: ${basePrompt}`,
        mediumReviewPrompt: `Review the changes and suggest verification for: ${basePrompt}`,
      };
  const debatePhase = {
    id: 'p2',
    title: labels.debate,
    failureMode: 'soft' as const,
    tasks: [
      {
        id: 'p2-t1',
        name: labels.minimalist,
        role: 'planner' as const,
        modelTaskRole: 'analysis' as const,
        preferredModelId: 'gpt-5.5',
        prompt: labels.minimalistPrompt,
      },
      {
        id: 'p2-t2',
        name: labels.builder,
        role: 'planner' as const,
        modelTaskRole: 'analysis' as const,
        preferredModelId: 'claude-opus-4.8',
        prompt: labels.builderPrompt,
      },
      {
        id: 'p2-t3',
        name: labels.skeptic,
        role: 'planner' as const,
        modelTaskRole: 'analysis' as const,
        preferredModelId: 'gemini-3.5-flash',
        prompt: labels.skepticPrompt,
      },
    ],
  };
  const arbitrationPhase = {
    id: 'p3',
    title: labels.arbitration,
    tasks: [
      {
        id: 'p3-t1',
        name: labels.arbiter,
        role: 'planner' as const,
        modelTaskRole: 'analysis' as const,
        preferredModelId: 'gpt-5.5',
        prompt: labels.arbiterPrompt,
      },
    ],
  };
  const implementationTasks =
    complexity === 'high'
      ? [
          {
            id: 'p4-t1',
            name: labels.coderCore,
            role: 'coder' as const,
            prompt: labels.corePrompt,
          },
          {
            id: 'p4-t2',
            name: labels.coderUi,
            role: 'coder' as const,
            prompt: labels.uiPrompt,
          },
        ]
      : [
          {
            id: 'p4-t1',
            name: labels.coder,
            role: 'coder' as const,
            prompt: labels.safePrompt,
          },
        ];

  const phases =
    complexity === 'high'
      ? [
          {
            id: 'p1',
            title: labels.discoveryHigh,
            tasks: [
              {
                id: 'p1-t1',
                name: labels.scanner,
                role: 'researcher' as const,
                modelTaskRole: 'analysis' as const,
                preferredModelId: 'gpt-5.5',
                prompt: labels.highDiscoveryPrompt,
              },
            ],
          },
          debatePhase,
          arbitrationPhase,
          {
            id: 'p4',
            title: labels.implementationHigh,
            tasks: implementationTasks,
          },
          {
            id: 'p5',
            title: labels.review,
            tasks: [
              {
                id: 'p5-t1',
                name: labels.reviewer,
                role: 'reviewer' as const,
                modelTaskRole: 'review' as const,
                preferredModelId: 'gpt-5.5',
                prompt: labels.highReviewPrompt,
              },
            ],
          },
        ]
      : [
          {
            id: 'p1',
            title: labels.discovery,
            tasks: [
              {
                id: 'p1-t1',
                name: labels.scanner,
                role: 'researcher' as const,
                modelTaskRole: 'analysis' as const,
                preferredModelId: 'gpt-5.5',
                prompt: labels.mediumDiscoveryPrompt,
              },
            ],
          },
          debatePhase,
          arbitrationPhase,
          {
            id: 'p4',
            title: labels.implementation,
            tasks: implementationTasks,
          },
          {
            id: 'p5',
            title: labels.review,
            tasks: [
              {
                id: 'p5-t1',
                name: labels.reviewer,
                role: 'reviewer' as const,
                modelTaskRole: 'review' as const,
                preferredModelId: 'gpt-5.5',
                prompt: labels.mediumReviewPrompt,
              },
            ],
          },
        ];

  return normalizeSwarmPlan({
    task_complexity: complexity,
    workflow: {
      description: labels.description,
      phases,
    },
  });
}

export function createBattleSwarmPlan(userPrompt: string): SwarmPlan {
  const basePrompt = userPrompt.trim();
  const russian = isLikelyRussian(basePrompt);
  const labels = russian
    ? {
        description: `Battle Agent для: ${basePrompt}`,
        firstRound: 'Раунд 1: независимый анализ',
        rebuttal: 'Раунд 2: возражения',
        synthesis: 'Синтезатор: Gemini 3.5',
        gpt: 'GPT-5.5 Pragmatist',
        opus: 'Opus 4.8 Architect',
        gptRebuttal: 'GPT-5.5 Rebuttal',
        opusRebuttal: 'Opus 4.8 Rebuttal',
        synthesizer: 'Gemini 3.5 Synthesizer',
        gptPrompt: `Ты GPT-5.5 в Battle Agent. Независимо исследуй код через tools поиска/чтения и предложи самый прагматичный инженерный фикс для задачи: ${basePrompt}. Обязательно назови конкретные файлы, отвечающие за planner, runner, model routing и UI sidebar, если они релевантны. Не изменяй файлы.`,
        opusPrompt: `Ты Opus 4.8 в Battle Agent. Независимо исследуй код через tools поиска/чтения и предложи самый архитектурно чистый подход для задачи: ${basePrompt}. Обязательно назови конкретные файлы, отвечающие за planner, runner, model routing и UI sidebar, если они релевантны. Не изменяй файлы.`,
        gptRebuttalPrompt: `Прочитай решение Opus 4.8 из предыдущего раунда. Возрази как GPT-5.5: что в архитектурном подходе избыточно, рискованно или медленно для задачи: ${basePrompt}. Не изменяй файлы.`,
        opusRebuttalPrompt: `Прочитай решение GPT-5.5 из предыдущего раунда. Возрази как Opus 4.8: где прагматичный подход создаст техдолг, пропустит edge cases или плохо масштабируется для задачи: ${basePrompt}. Не изменяй файлы.`,
        synthesisPrompt: `Ты Gemini 3.5, финальный Синтезатор и Судья Battle Agent. Используй огромное контекстное окно: прочитай исходную задачу, контекст файлов IDE, решение GPT-5.5, возражения Opus 4.8 на него, решение Opus 4.8 и возражения GPT-5.5 на него. Не жди консенсуса: если модели спорят, выбери финальный вариант по критериям минимального риска, совместимости с текущей архитектурой, объема изменений, проверяемости и UX. Сведи лучшие элементы обоих подходов в один бесконфликтный план/код. Выдай только краткое резюме решения, почему оно выбрано, и конкретные файлы для изменения. Не изменяй файлы.`,
      }
    : {
        description: `Battle Agent for: ${basePrompt}`,
        firstRound: 'Round 1: Independent Analysis',
        rebuttal: 'Round 2: Rebuttals',
        synthesis: 'Synthesizer: Gemini 3.5',
        gpt: 'GPT-5.5 Pragmatist',
        opus: 'Opus 4.8 Architect',
        gptRebuttal: 'GPT-5.5 Rebuttal',
        opusRebuttal: 'Opus 4.8 Rebuttal',
        synthesizer: 'Gemini 3.5 Synthesizer',
        gptPrompt: `You are GPT-5.5 in Battle Agent. Independently inspect the code through search/read tools and propose the most pragmatic engineering fix for: ${basePrompt}. Name the concrete files responsible for planner, runner, model routing, and UI sidebar when relevant. Do not edit files.`,
        opusPrompt: `You are Opus 4.8 in Battle Agent. Independently inspect the code through search/read tools and propose the cleanest architectural approach for: ${basePrompt}. Name the concrete files responsible for planner, runner, model routing, and UI sidebar when relevant. Do not edit files.`,
        gptRebuttalPrompt: `Read the previous-round Opus 4.8 answer. Rebut as GPT-5.5: what is overbuilt, risky, or too slow for: ${basePrompt}. Do not edit files.`,
        opusRebuttalPrompt: `Read the previous-round GPT-5.5 answer. Rebut as Opus 4.8: where the pragmatic approach creates debt, misses edge cases, or scales poorly for: ${basePrompt}. Do not edit files.`,
        synthesisPrompt: `You are Gemini 3.5, the final Synthesizer and Judge for Battle Agent. Use your large context window: read the original user task, IDE file context, the GPT-5.5 solution, Opus 4.8's rebuttal to it, the Opus 4.8 solution, and GPT-5.5's rebuttal to it. Do not wait for consensus: if the models disagree, choose the final option using these criteria: lowest risk, fit with the existing architecture, smallest coherent change size, verifiability, and UX. Merge the best parts of both approaches into one conflict-free final plan/code. Output only a concise decision summary, why it was chosen, and concrete files to change. Do not edit files.`,
      };

  return normalizeSwarmPlan({
    task_complexity: 'high',
    workflow: {
      description: labels.description,
      phases: [
        {
          id: 'p1',
          title: labels.firstRound,
          failureMode: 'soft',
          tasks: [
            {
              id: 'p1-t1',
              name: labels.gpt,
              role: 'planner',
              modelTaskRole: 'analysis',
              preferredModelId: 'gpt-5.5',
              prompt: labels.gptPrompt,
            },
            {
              id: 'p1-t2',
              name: labels.opus,
              role: 'planner',
              modelTaskRole: 'analysis',
              preferredModelId: 'claude-opus-4.8',
              prompt: labels.opusPrompt,
            },
          ],
        },
        {
          id: 'p2',
          title: labels.rebuttal,
          failureMode: 'soft',
          tasks: [
            {
              id: 'p2-t1',
              name: labels.gptRebuttal,
              role: 'planner',
              modelTaskRole: 'analysis',
              preferredModelId: 'gpt-5.5',
              prompt: labels.gptRebuttalPrompt,
            },
            {
              id: 'p2-t2',
              name: labels.opusRebuttal,
              role: 'planner',
              modelTaskRole: 'analysis',
              preferredModelId: 'claude-opus-4.8',
              prompt: labels.opusRebuttalPrompt,
            },
          ],
        },
        {
          id: 'p3',
          title: labels.synthesis,
          tasks: [
            {
              id: 'p3-t1',
              name: labels.synthesizer,
              role: 'planner',
              modelTaskRole: 'analysis',
              preferredModelId: 'gemini-3.5-flash',
              prompt: labels.synthesisPrompt,
            },
          ],
        },
      ],
    },
  });
}
