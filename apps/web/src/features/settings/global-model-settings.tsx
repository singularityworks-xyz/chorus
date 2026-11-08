"use client";

import {
  type ModelSelection,
  opencodeModelCatalogSchema,
} from "@chorus/contracts";
import { useEffect, useMemo, useState } from "react";
import { createModelKey, ModelPicker } from "@/components/model-picker";
import { useWorkspace } from "@/features/workspace/workspace-context";

async function fetchModelCatalog(signal: AbortSignal, refreshKey: number) {
  const refreshQuery = refreshKey > 0 ? `?refresh=${refreshKey}` : "";
  const response = await fetch(`/api/models${refreshQuery}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error("model_catalog_unavailable");
  }
  return opencodeModelCatalogSchema.parse(await response.json());
}

function getSelectionWarning(
  selection: ModelSelection | null,
  models: ReturnType<typeof opencodeModelCatalogSchema.parse>["models"]
): string | null {
  if (!selection) {
    return null;
  }
  const selectedModel = models.find(
    (model) => createModelKey(model) === createModelKey(selection)
  );
  if (!selectedModel) {
    return "The selected model is no longer available. Choose a connected model.";
  }
  if (!selectedModel.connected) {
    return "The selected provider is disconnected. Reconnect it before starting new tasks.";
  }
  return null;
}

export function GlobalModelSettings() {
  const { addRecentModel, preferences, setDefaultModelSelection } =
    useWorkspace();
  const [availableModels, setAvailableModels] = useState<
    ReturnType<typeof opencodeModelCatalogSchema.parse>["models"]
  >([]);
  const [providerDefault, setProviderDefault] = useState<
    ModelSelection | undefined
  >();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchModelCatalog(controller.signal, refreshKey)
      .then((catalog) => {
        if (controller.signal.aborted) {
          return;
        }
        setAvailableModels(catalog.models);
        setProviderDefault(catalog.defaultModel);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError(
            "Could not load available models. Check the engine connection and retry."
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [refreshKey]);

  const selectedKey = useMemo(() => {
    const selection = preferences.defaultModelSelection;
    return selection ? createModelKey(selection) : "";
  }, [preferences.defaultModelSelection]);
  const currentSelectionWarning = loading
    ? null
    : getSelectionWarning(preferences.defaultModelSelection, availableModels);

  async function saveSelection(value: string) {
    const model = availableModels.find(
      (candidate) => createModelKey(candidate) === value
    );

    if (!model) {
      setError(
        "That model is no longer available. Refresh the catalog and choose another."
      );
      return;
    }
    if (!model.connected) {
      setError("Connect this provider in Settings before selecting its model.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const selection = {
        modelID: model.modelID,
        providerID: model.providerID,
      };
      await setDefaultModelSelection(selection);
      addRecentModel(selection);
    } catch {
      setError(
        "Could not confirm the model setting. Reload Settings to verify before trying again."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-2 border border-white/8 bg-white/[0.025] px-2.5 py-2.5">
      <div className="text-[10px] text-white/45 uppercase tracking-[0.18em]">
        Model for every board
      </div>
      <div className="mt-2">
        <ModelPicker
          allowDefaultOption={false}
          availableModels={availableModels}
          className="w-full"
          defaultModel={providerDefault}
          loading={loading || saving}
          onValueChange={(value) => {
            saveSelection(value);
          }}
          recentlyUsedModels={preferences.recentlyUsedModels}
          value={selectedKey}
        />
      </div>
      <p className="mt-1.5 text-[10px] text-white/38 leading-4">
        Choose one model for new runs on every board. Running tasks keep their
        current model.
      </p>
      {preferences.defaultModelSelection || loading ? null : (
        <p className="mt-1 text-[10px] text-amber-100/75 leading-4">
          Choose a model before starting a task.
        </p>
      )}
      {currentSelectionWarning ? (
        <p
          className="mt-1 text-[10px] text-amber-100/75 leading-4"
          role="alert"
        >
          {currentSelectionWarning}
        </p>
      ) : null}
      {error ? (
        <div
          className="mt-2 flex items-start justify-between gap-2"
          role="alert"
        >
          <p className="text-[10px] text-rose-200/90 leading-4">{error}</p>
          <button
            className="shrink-0 text-[10px] text-cyan-200 underline underline-offset-2"
            onClick={() => setRefreshKey((key) => key + 1)}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
    </section>
  );
}
