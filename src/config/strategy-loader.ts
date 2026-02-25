import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import type { StrategyConfig } from '../types/strategy.js';
import { getDefaultStrategyConfig, getPresetStrategyConfig } from '../types/strategy.js';
import type { StrategyPreset } from '../types/strategy.js';

/**
 * Load a strategy config from a JSON file.
 * Merges with defaults to ensure all fields are present.
 */
export function loadStrategyFromFile(filePath: string, marketId: string): StrategyConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  const defaults = getDefaultStrategyConfig(marketId);

  return mergeWithDefaults(parsed, defaults, marketId);
}

/**
 * Load all strategy JSON files from a directory.
 */
export function loadStrategiesFromDir(dir: string): Map<string, any> {
  const strategies = new Map<string, any>();
  if (!existsSync(dir)) return strategies;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = readFileSync(resolve(dir, file), 'utf-8');
      const parsed = JSON.parse(raw);
      const name = basename(file, '.json');
      strategies.set(name, parsed);
    } catch (err) {
      console.error(`Failed to load strategy file ${file}:`, err);
    }
  }
  return strategies;
}

/**
 * Save a strategy config to a JSON file.
 */
export function saveStrategyToFile(dir: string, name: string, config: StrategyConfig): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = resolve(dir, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}

/**
 * Get a strategy config by preset name or file path.
 */
export function resolveStrategy(
  source: string,
  marketId: string,
  strategiesDir: string
): StrategyConfig {
  // Check if it's a preset name
  const presets: StrategyPreset[] = ['simple', 'volumeMaximizing', 'profitTaking', 'custom'];
  if (presets.includes(source as StrategyPreset)) {
    return getPresetStrategyConfig(marketId, source as StrategyPreset);
  }

  // Check if it's a file in the strategies directory
  const filePath = resolve(strategiesDir, `${source}.json`);
  if (existsSync(filePath)) {
    return loadStrategyFromFile(filePath, marketId);
  }

  // Check if it's an absolute path
  if (existsSync(source)) {
    return loadStrategyFromFile(source, marketId);
  }

  // Fail loudly instead of silently using wrong strategy
  console.error(`Strategy "${source}" not found.`);
  console.error(`Available presets: ${presets.join(', ')}`);
  console.error(`Also checked: ${filePath}`);
  process.exit(1);
}

/**
 * Initialize the strategies directory with preset files.
 */
export function initStrategiesDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const presets: StrategyPreset[] = ['simple', 'volumeMaximizing', 'profitTaking'];
  for (const preset of presets) {
    const filePath = resolve(dir, `${preset}.json`);
    if (!existsSync(filePath)) {
      const config = getPresetStrategyConfig('default', preset);
      writeFileSync(filePath, JSON.stringify(config, null, 2));
    }
  }
}

function mergeWithDefaults(
  partial: Partial<StrategyConfig>,
  defaults: StrategyConfig,
  marketId: string
): StrategyConfig {
  return {
    ...defaults,
    ...partial,
    marketId,
    orderConfig: { ...defaults.orderConfig, ...partial.orderConfig },
    positionSizing: { ...defaults.positionSizing, ...partial.positionSizing },
    orderManagement: { ...defaults.orderManagement, ...partial.orderManagement },
    riskManagement: { ...defaults.riskManagement, ...partial.riskManagement },
    timing: { ...defaults.timing, ...partial.timing },
    isActive: partial.isActive ?? defaults.isActive,
    createdAt: partial.createdAt ?? defaults.createdAt,
    updatedAt: Date.now(),
  };
}
