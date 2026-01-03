import { DEFAULT_PROVIDER } from '@lobechat/business-const';
import { DEFAULT_MODEL, DEFAUTT_AGENT_TTS_CONFIG } from '@lobechat/const';
import type { AgentBuilderContext } from '@lobechat/context-engine';
import {
  type AgentMode,
  type LobeAgentModeConfig,
  type LobeAgentTTSConfig,
  type LocalSystemConfig,
} from '@lobechat/types';

import type { AgentStoreState } from '../initialState';
import { agentSelectors } from './selectors';

/**
 * Selectors that get agent config by agentId parameter.
 * Used in ChatInput components where agentId is passed as prop.
 */

const getAgentModelById =
  (agentId: string) =>
  (s: AgentStoreState): string =>
    agentSelectors.getAgentConfigById(agentId)(s)?.model || DEFAULT_MODEL;

const getAgentModelProviderById =
  (agentId: string) =>
  (s: AgentStoreState): string =>
    agentSelectors.getAgentConfigById(agentId)(s)?.provider || DEFAULT_PROVIDER;

const getAgentPluginsById =
  (agentId: string) =>
  (s: AgentStoreState): string[] =>
    agentSelectors.getAgentConfigById(agentId)(s)?.plugins || [];

const getAgentSystemRoleById =
  (agentId: string) =>
  (s: AgentStoreState): string | undefined =>
    agentSelectors.getAgentConfigById(agentId)(s)?.systemRole;

const getAgentTTSById =
  (agentId: string) =>
  (s: AgentStoreState): LobeAgentTTSConfig =>
    agentSelectors.getAgentConfigById(agentId)(s)?.tts || DEFAUTT_AGENT_TTS_CONFIG;

const getAgentFilesById = (agentId: string) => (s: AgentStoreState) =>
  agentSelectors.getAgentConfigById(agentId)(s)?.files || [];

const getAgentKnowledgeBasesById = (agentId: string) => (s: AgentStoreState) =>
  agentSelectors.getAgentConfigById(agentId)(s)?.knowledgeBases || [];

const isAgentConfigLoadingById = (agentId: string) => (s: AgentStoreState) =>
  !agentId || !s.agentMap[agentId];

/**
 * Get agent mode config by agentId
 */
const getAgentModeConfigById =
  (agentId: string) =>
  (s: AgentStoreState): LobeAgentModeConfig | undefined =>
    agentSelectors.getAgentConfigById(agentId)(s)?.agentConfig;

/**
 * Get agent mode by agentId
 * Supports backward compatibility: prefers agentConfig.mode, falls back to enableAgentMode
 */
const getAgentModeById =
  (agentId: string) =>
  (s: AgentStoreState): AgentMode | undefined => {
    const config = agentSelectors.getAgentConfigById(agentId)(s);

    // Prefer agentConfig.mode if available
    if (config?.agentConfig?.mode) {
      return config.agentConfig.mode;
    }

    // Fallback: convert deprecated enableAgentMode to mode
    // enableAgentMode: true -> 'auto' (default agent mode)
    // enableAgentMode: false/undefined -> undefined (agent mode disabled)
    if (config?.enableAgentMode) {
      return 'auto';
    }

    return undefined;
  };

/**
 * Check if agent mode is enabled by agentId
 * Supports backward compatibility with deprecated enableAgentMode field
 */
const getAgentEnableModeById =
  (agentId: string) =>
  (s: AgentStoreState): boolean => {
    const mode = getAgentModeById(agentId)(s);
    return mode !== undefined;
  };

/**
 * Get local system config by agentId
 */
const getAgentLocalSystemConfigById =
  (agentId: string) =>
  (s: AgentStoreState): LocalSystemConfig | undefined =>
    getAgentModeConfigById(agentId)(s)?.localSystem;

/**
 * Get working directory by agentId
 */
const getAgentWorkingDirectoryById =
  (agentId: string) =>
  (s: AgentStoreState): string | undefined =>
    getAgentLocalSystemConfigById(agentId)(s)?.workingDirectory;

/**
 * Get agent builder context by agentId
 * Used for injecting current agent config/meta into Agent Builder context
 */
const getAgentBuilderContextById =
  (agentId: string) =>
  (s: AgentStoreState): AgentBuilderContext => {
    const config = agentSelectors.getAgentConfigById(agentId)(s);
    const meta = agentSelectors.getAgentMetaById(agentId)(s);

    return {
      config: {
        chatConfig: config.chatConfig,
        model: config.model,
        openingMessage: config.openingMessage,
        openingQuestions: config.openingQuestions,
        params: config.params,
        plugins: config.plugins,
        provider: config.provider,
        systemRole: config.systemRole,
      },
      meta,
    };
  };

export const agentByIdSelectors = {
  getAgentBuilderContextById,
  getAgentConfigById: agentSelectors.getAgentConfigById,
  getAgentEnableModeById,
  getAgentFilesById,
  getAgentKnowledgeBasesById,
  getAgentLocalSystemConfigById,
  getAgentModeById,
  getAgentModeConfigById,
  getAgentModelById,
  getAgentModelProviderById,
  getAgentPluginsById,
  getAgentSystemRoleById,
  getAgentTTSById,
  getAgentWorkingDirectoryById,
  isAgentConfigLoadingById,
};
