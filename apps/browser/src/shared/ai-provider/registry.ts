import type { AIProviderAdapter, AIProviderType } from './types';

export class AIProviderRegistry {
  private readonly adapters = new Map<string, AIProviderAdapter>();

  public register(adapter: AIProviderAdapter): void {
    const id = adapter.id.trim();
    if (!id) throw new Error('Provider adapter ID must not be empty.');
    if (this.adapters.has(id)) {
      throw new Error(`Provider adapter "${id}" is already registered.`);
    }
    this.adapters.set(id, adapter);
  }

  public unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  public get(id: string): AIProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  public require(id: string): AIProviderAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`Unknown provider adapter "${id}".`);
    return adapter;
  }

  public list(type?: AIProviderType): AIProviderAdapter[] {
    const adapters = Array.from(this.adapters.values());
    return type
      ? adapters.filter((adapter) => adapter.type === type)
      : adapters;
  }
}
