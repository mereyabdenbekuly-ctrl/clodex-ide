import type { ModelTaskRole } from '@clodex/agent-core/host';
import { getAvailableModel } from '@shared/available-models';
import type { ClodexAuthModel } from './model-provider-types';
import { getBareModelId } from './model-provider-catalog';

export function getClodexModelLabel(model: ClodexAuthModel): string {
  return `${model.provider ?? ''} ${model.id} ${model.name ?? ''}`.toLowerCase();
}

function getKnownPriceRank(model: ClodexAuthModel): number | undefined {
  const builtIn =
    getAvailableModel(model.id) ?? getAvailableModel(getBareModelId(model.id));
  return builtIn?.pricing?.relativeMultiplier;
}

export function scoreClodexModelMetadataForTask(
  model: ClodexAuthModel,
  taskRole: ModelTaskRole,
  currentModelId: string,
): number {
  if (!model.taskRoles?.includes(taskRole)) return Number.NEGATIVE_INFINITY;

  const currentBonus =
    model.id === currentModelId ||
    getBareModelId(model.id) === getBareModelId(currentModelId)
      ? 3
      : 0;
  const contextBonus =
    typeof model.contextWindow === 'number'
      ? Math.min(10, Math.floor(model.contextWindow / 200_000))
      : 0;

  if (taskRole === 'coding') {
    const tierScore = tierScoreForStrongModel(model.costTier);
    return 100 + tierScore + contextBonus + currentBonus;
  }

  const tierScore = tierScoreForEfficientModel(model.costTier);
  return 100 + tierScore + currentBonus;
}

function tierScoreForStrongModel(
  tier: ClodexAuthModel['costTier'] | undefined,
): number {
  switch (tier) {
    case 'high':
      return 40;
    case 'medium':
      return 25;
    case 'low':
      return 10;
    case 'free':
      return 5;
    default:
      return 15;
  }
}

function tierScoreForEfficientModel(
  tier: ClodexAuthModel['costTier'] | undefined,
): number {
  switch (tier) {
    case 'free':
      return 45;
    case 'low':
      return 40;
    case 'medium':
      return 20;
    case 'high':
      return 5;
    default:
      return 15;
  }
}

export function scoreClodexModelForTask(
  model: ClodexAuthModel,
  taskRole: ModelTaskRole,
  currentModelId: string,
): number {
  const label = getClodexModelLabel(model);
  const priceRank = getKnownPriceRank(model);
  const lowerPriceBonus =
    priceRank === undefined ? 0 : Math.max(-30, 30 - priceRank * 8);
  const higherPriceBonus =
    priceRank === undefined ? 0 : Math.min(30, priceRank * 6);
  const currentBonus =
    model.id === currentModelId ||
    getBareModelId(model.id) === getBareModelId(currentModelId)
      ? 3
      : 0;
  const hasAny = (...needles: string[]) =>
    needles.some((needle) => label.includes(needle));

  if (taskRole === 'analysis') {
    let score = 50 + lowerPriceBonus + currentBonus;
    if (hasAny('flash', 'lite', 'mini', 'haiku', 'quick', 'fast')) score += 35;
    if (hasAny('deepseek', 'qwen', 'glm', 'gemini')) score += 12;
    if (hasAny('opus', 'fable', 'sonnet', 'pro', 'max')) score -= 18;
    return score;
  }

  if (taskRole === 'review') {
    let score = 45 + lowerPriceBonus + currentBonus;
    if (hasAny('flash', 'lite', 'mini', 'haiku', 'quick', 'fast')) score += 30;
    if (hasAny('deepseek', 'qwen', 'glm', 'gemini')) score += 10;
    if (hasAny('opus', 'fable')) score -= 15;
    return score;
  }

  let score = 55 + higherPriceBonus + currentBonus;
  if (
    hasAny(
      'opus',
      'fable',
      'sonnet',
      'gpt-5',
      'gpt-4.1',
      'glm-5',
      'deepseek-v4-pro',
    )
  ) {
    score += 35;
  }
  if (hasAny('mini', 'lite', 'haiku', 'flash')) score -= 20;
  if (hasAny('coding', 'coder', 'code')) score += 18;
  return score;
}
