class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    this.providers.set(provider.id, provider);
  }

  clear() {
    this.providers.clear();
  }

  get(id) {
    return this.providers.get(id);
  }

  first() {
    return this.providers.values().next().value;
  }

  list() {
    return Array.from(this.providers.values()).map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      defaultModel: provider.defaultModel,
      models: Array.isArray(provider.models) ? provider.models : [],
      hiddenModels: Array.isArray(provider.hiddenModels) ? provider.hiddenModels : []
    }));
  }
}

module.exports = {
  ProviderRegistry
};
