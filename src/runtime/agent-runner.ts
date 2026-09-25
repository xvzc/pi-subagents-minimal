import { basename, dirname } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  ExtensionRunner,
  type ModelRegistry,
  SessionManager as PiSessionManager,
  type ResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveExtensionSources } from "../agents/extensions.js";
import type {
  StoredError,
  StoredErrorDiagnostic,
  StoredUsage,
} from "../storage/schemas.js";
import type { ThinkingLevel } from "../types.js";

export const CHILD_TOOL_NAMES = Object.freeze([
  ...new Set([
    ...createCodingTools(process.cwd()).map((tool) => tool.name),
    ...createReadOnlyTools(process.cwd()).map((tool) => tool.name),
  ]),
]);

export interface ChildExtensionPrepareInput {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  extensions: string[];
  modelRegistry?: ModelRegistry;
}

export interface ChildExtensionPreparation {
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
  knownToolNames: readonly string[];
  knownSkillNames: readonly string[];
  dispose(): void;
}

export interface ChildSessionCreateInput {
  id: string;
  cwd: string;
  agentDir: string;
  parentSessionId: string;
  model: Model<Api>;
  modelRegistry: ModelRegistry;
  thinking: ThinkingLevel;
  systemPrompt: string;
  tools?: string[];
  skills?: string[];
  maxTurns?: number;
  extensionPreparation?: ChildExtensionPreparation;
}

export interface ChildExecutionObservation {
  output?: string;
  usage?: StoredUsage;
  /** Confirmed usage for this prompt invocation; never persisted. */
  widgetUsage?: { turns: number; input: number; output: number };
  error?: StoredError;
  aborted?: boolean;
  maxTurnsReached?: boolean;
}

export interface ChildSessionHandle {
  prompt(
    prompt: string,
    onProgress?: (observation: ChildExecutionObservation) => void,
  ): Promise<ChildExecutionObservation>;
  configure(input: {
    model?: Model<Api>;
    thinking?: ThinkingLevel;
  }): Promise<void>;
  steer(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose?(): void;
}

export interface ChildSessionFactory {
  readonly knownToolNames: readonly string[];
  prepareExtensions?(
    input: ChildExtensionPrepareInput,
  ): Promise<ChildExtensionPreparation>;
  create(input: ChildSessionCreateInput): Promise<ChildSessionHandle>;
}

export function filterSkills(
  resourceLoader: ResourceLoader,
  selectedNames: readonly string[],
): ResourceLoader {
  const selected = new Set(selectedNames);
  return {
    getExtensions: () => resourceLoader.getExtensions(),
    getSkills: () => {
      const loaded = resourceLoader.getSkills();
      return {
        ...loaded,
        skills: loaded.skills.filter((skill) => selected.has(skill.name)),
      };
    },
    getPrompts: () => resourceLoader.getPrompts(),
    getThemes: () => resourceLoader.getThemes(),
    getAgentsFiles: () => resourceLoader.getAgentsFiles(),
    getSystemPrompt: () => resourceLoader.getSystemPrompt(),
    getSystemPromptSource: () => resourceLoader.getSystemPromptSource(),
    getAppendSystemPrompt: () => resourceLoader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () =>
      resourceLoader.getAppendSystemPromptSources(),
    extendResources: (paths) => resourceLoader.extendResources(paths),
    reload: (options) => resourceLoader.reload(options),
  };
}

const ASSISTANT_ERROR: StoredError = Object.freeze({
  code: "CHILD_EXECUTION_FAILED",
  message: "The child assistant turn failed.",
});

/** Build child sessions only through Pi's public SDK surface. */
export function createPiChildSessionFactory(): ChildSessionFactory {
  return {
    knownToolNames: CHILD_TOOL_NAMES,
    async prepareExtensions(input): Promise<ChildExtensionPreparation> {
      const additionalExtensionPaths = await resolveExtensionSources(
        input.extensions,
        input.cwd,
        input.agentDir,
      );
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir: input.agentDir,
        settingsManager,
        noExtensions: true,
        systemPrompt: input.systemPrompt,
        additionalExtensionPaths,
      });
      try {
        await resourceLoader.reload();
      } catch (error) {
        try {
          resourceLoader.getExtensions().runtime.invalidate();
        } catch {
          // Preserve the loader failure; cleanup is best-effort.
        }
        throw error;
      }
      const loaded = resourceLoader.getExtensions();
      const sourceLoaded = (source: string) =>
        loaded.extensions.some(
          (extension) => extension.resolvedPath === source,
        );
      if (
        loaded.errors.length > 0 ||
        additionalExtensionPaths.some((source) => !sourceLoaded(source))
      ) {
        loaded.runtime.invalidate();
        throw new Error("Selected extension loading failed.");
      }
      if (input.modelRegistry !== undefined) {
        const runner = new ExtensionRunner(
          loaded.extensions,
          loaded.runtime,
          input.cwd,
          PiSessionManager.inMemory(input.cwd),
          input.modelRegistry,
        );
        let discoveryFailed = false;
        const unsubscribe = runner.onError(() => {
          discoveryFailed = true;
        });
        try {
          const discovered = await runner.emitResourcesDiscover(
            input.cwd,
            "startup",
          );
          if (discoveryFailed) {
            throw new Error("Selected extension resource discovery failed.");
          }
          const resourceEntries = (
            entries: Array<{ path: string; extensionPath: string }>,
          ) =>
            entries.map(({ path, extensionPath }) => ({
              path,
              metadata: {
                source: extensionPath.startsWith("<")
                  ? `extension:${extensionPath.replace(/[<>]/g, "")}`
                  : `extension:${basename(extensionPath).replace(/\.(ts|js)$/, "")}`,
                scope: "temporary" as const,
                origin: "top-level" as const,
                ...(extensionPath.startsWith("<")
                  ? {}
                  : { baseDir: dirname(extensionPath) }),
              },
            }));
          resourceLoader.extendResources({
            skillPaths: resourceEntries(discovered.skillPaths),
            promptPaths: resourceEntries(discovered.promptPaths),
            themePaths: resourceEntries(discovered.themePaths),
          });
          for (const extension of loaded.extensions) {
            extension.handlers.delete("resources_discover");
          }
        } catch (error) {
          loaded.runtime.invalidate();
          throw error;
        } finally {
          unsubscribe();
        }
      }
      const knownToolNames = new Set(CHILD_TOOL_NAMES);
      for (const extension of loaded.extensions) {
        for (const name of extension.tools.keys()) {
          if (knownToolNames.has(name)) {
            loaded.runtime.invalidate();
            throw new Error("Selected extensions contain a tool conflict.");
          }
          knownToolNames.add(name);
        }
      }
      let disposed = false;
      return {
        resourceLoader,
        settingsManager,
        knownToolNames: [...knownToolNames],
        knownSkillNames: resourceLoader
          .getSkills()
          .skills.map((skill) => skill.name),
        dispose() {
          if (disposed) return;
          disposed = true;
          loaded.runtime.invalidate();
        },
      };
    },
    async create(input): Promise<ChildSessionHandle> {
      // Resolve the exact catalog object again at the creation boundary. This also
      // preserves extension-registered catalog models even when authentication for
      // them cannot be transferred through the public SDK.
      const concrete = input.modelRegistry.find(
        input.model.provider,
        input.model.id,
      );
      if (!concrete)
        throw new Error("The resolved child model is no longer registered.");

      const settingsManager =
        input.extensionPreparation?.settingsManager ??
        SettingsManager.inMemory();
      const baseResourceLoader =
        input.extensionPreparation?.resourceLoader ??
        new DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: input.agentDir,
          settingsManager,
          noExtensions: true,
          systemPrompt: input.systemPrompt,
        });
      if (input.extensionPreparation === undefined)
        await baseResourceLoader.reload();
      const resourceLoader = filterSkills(
        baseResourceLoader,
        input.skills ?? [],
      );
      const { session } = await createAgentSession({
        cwd: input.cwd,
        agentDir: input.agentDir,
        model: concrete,
        thinkingLevel: input.thinking,
        ...(input.tools !== undefined ? { tools: [...input.tools] } : {}),
        resourceLoader,
        settingsManager,
        sessionManager: PiSessionManager.inMemory(input.cwd, {
          id: input.id,
          parentSession: input.parentSessionId,
        }),
      });

      return {
        async prompt(prompt, progress): Promise<ChildExecutionObservation> {
          let turns = 0;
          let confirmedInput = 0;
          let confirmedOutput = 0;
          let pendingInput = 0;
          let pendingOutput = 0;
          let failureDiagnostic: StoredErrorDiagnostic | undefined;
          let aborted = false;
          let maxTurnsReached = false;
          let output: string | undefined;
          const observe = (): ChildExecutionObservation => {
            const stats = session.getSessionStats();
            return {
              ...(output !== undefined ? { output } : {}),
              usage: {
                turns: stats.assistantMessages,
                tool_uses: stats.toolCalls,
                total_tokens: stats.tokens.total,
              },
              ...(turns > 0
                ? {
                    widgetUsage: {
                      turns,
                      input: confirmedInput,
                      output: confirmedOutput,
                    },
                  }
                : {}),
            };
          };
          const unsubscribe = session.subscribe((event) => {
            if (
              event.type === "message_end" &&
              event.message.role === "assistant"
            ) {
              pendingInput += event.message.usage.input;
              pendingOutput += event.message.usage.output;
              return;
            }
            if (event.type !== "turn_end" || event.message.role !== "assistant")
              return;
            turns += 1;
            confirmedInput += pendingInput;
            confirmedOutput += pendingOutput;
            pendingInput = 0;
            pendingOutput = 0;
            output = session.getLastAssistantText();
            if (event.message.stopReason === "error") {
              failureDiagnostic = {
                phase: "assistant_stop",
                assistant_turn: turns,
                stop_reason: event.message.stopReason,
              };
            }
            if (event.message.stopReason === "aborted") aborted = true;
            progress?.(observe());
          });
          session.agent.shouldStopAfterTurn = () => {
            if (input.maxTurns !== undefined && turns >= input.maxTurns) {
              maxTurnsReached = true;
              return true;
            }
            return false;
          };

          try {
            await session.prompt(prompt, {
              expandPromptTemplates: false,
              source: "extension",
            });
          } catch {
            if (failureDiagnostic === undefined) {
              failureDiagnostic = { phase: "prompt_throw" };
            }
          } finally {
            unsubscribe();
          }
          return {
            ...observe(),
            ...(failureDiagnostic !== undefined
              ? { error: { ...ASSISTANT_ERROR, diagnostic: failureDiagnostic } }
              : {}),
            ...(aborted ? { aborted: true } : {}),
            ...(maxTurnsReached ? { maxTurnsReached: true } : {}),
          };
        },
        async configure(configuration): Promise<void> {
          if (configuration.model !== undefined) {
            await session.setModel(configuration.model);
          }
          if (configuration.thinking !== undefined) {
            session.setThinkingLevel(configuration.thinking);
          }
        },
        async steer(prompt): Promise<void> {
          await session.steer(prompt.trim());
        },
        async abort(): Promise<void> {
          await session.abort();
        },
        dispose(): void {
          session.dispose();
        },
      };
    },
  };
}
