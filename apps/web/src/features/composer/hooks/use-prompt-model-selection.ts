import {
  type ModelSelection,
  type OpencodeModelSummary,
  opencodeModelCatalogSchema,
} from "@chorus/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createModelKey } from "@/features/models/components/model-picker/lib/model-key";
import { providerCatalogInvalidator } from "@/features/settings/provider-catalog-invalidator";
import { isWorkspaceSessionLive } from "@/features/workspace/session-status";
import { useWorkspace } from "@/features/workspace/workspace-context";
import {
  modelCatalogLoadErrorMessage,
  preserveAvailableModelSelection,
} from "../lib/prompt-input";

export function usePromptModelSelection() {
  const {
    addRecentModel,
    preferences,
    sessionStatus,
    setDefaultModelSelection,
  } = useWorkspace();
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [modelSelectionError, setModelSelectionError] = useState<string | null>(
    null
  );
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [availableModels, setAvailableModels] = useState<
    OpencodeModelSummary[]
  >([]);
  const [defaultModel, setDefaultModel] = useState<
    ModelSelection | undefined
  >();

  useEffect(() => {
    if (!isWorkspaceSessionLive(sessionStatus)) {
      return;
    }

    let isCancelled = false;
    let activeController: AbortController | undefined;

    async function loadModels() {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      setIsLoadingModels(true);

      try {
        const response = await fetch("/api/models", {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        });

        if (!response.ok) {
          throw new Error(`model_catalog_http_${String(response.status)}`);
        }
        const payload = opencodeModelCatalogSchema.parse(await response.json());
        if (isCancelled || controller.signal.aborted) {
          return;
        }

        setAvailableModels(payload.models);
        setDefaultModel(payload.defaultModel);
        setModelSelectionError(null);
        setSelectedModelKey((currentValue) =>
          preserveAvailableModelSelection(currentValue, payload.models)
        );
      } catch (error) {
        if (isCancelled || controller.signal.aborted) {
          return;
        }
        setModelSelectionError(modelCatalogLoadErrorMessage(error));
      } finally {
        if (!(isCancelled || controller.signal.aborted)) {
          setIsLoadingModels(false);
        }
      }
    }

    function refreshModels() {
      loadModels().catch((error: unknown) => {
        if (!isCancelled) {
          setModelSelectionError(modelCatalogLoadErrorMessage(error));
        }
      });
    }

    const unsubscribe = providerCatalogInvalidator.subscribe(refreshModels);
    refreshModels();

    return () => {
      isCancelled = true;
      activeController?.abort();
      unsubscribe();
    };
  }, [sessionStatus]);

  useEffect(() => {
    const defaultSelection = preferences.defaultModelSelection;
    setSelectedModelKey(
      defaultSelection
        ? `${defaultSelection.providerID}/${defaultSelection.modelID}`
        : ""
    );
  }, [preferences.defaultModelSelection]);

  const selectedModel = useMemo(() => {
    const [providerID, modelID] = selectedModelKey.split("/");
    if (!(providerID && modelID)) {
      return undefined;
    }

    return { providerID, modelID } satisfies ModelSelection;
  }, [selectedModelKey]);

  const handleModelValueChange = useCallback(
    async (value: string) => {
      setSelectedModelKey(value);
      setModelSelectionError(null);
      try {
        const model = availableModels.find(
          (candidate) => createModelKey(candidate) === value
        );
        if (!model) {
          throw new Error("model_unavailable");
        }
        if (!model.connected) {
          throw new Error("provider_not_connected");
        }
        const selection = {
          providerID: model.providerID,
          modelID: model.modelID,
        };
        await setDefaultModelSelection(selection);
        addRecentModel(selection);
      } catch (error) {
        const savedSelection = preferences.defaultModelSelection;
        setSelectedModelKey(
          savedSelection
            ? `${savedSelection.providerID}/${savedSelection.modelID}`
            : ""
        );
        setModelSelectionError(
          error instanceof Error && error.message === "provider_not_connected"
            ? "Connect this provider in Settings before selecting its model."
            : "Could not save the application model. Try again in Settings."
        );
      }
    },
    [
      addRecentModel,
      availableModels,
      preferences.defaultModelSelection,
      setDefaultModelSelection,
    ]
  );

  return {
    availableModels,
    defaultModel,
    handleModelValueChange,
    isLoadingModels,
    modelSelectionError,
    selectedModel,
    selectedModelKey,
  };
}
