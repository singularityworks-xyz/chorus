import { expect, test } from "bun:test";
import type { ModelSelection } from "@chorus/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "./model-picker";

const model = {
  attachment: false,
  connected: true,
  modelID: "scripted",
  name: "Scripted Model",
  providerID: "fixture",
  providerName: "Fixture Provider",
  reasoning: true,
  releaseDate: "",
  temperature: false,
  toolCall: true,
};

function renderPicker(
  value: string,
  options: {
    availableModels?: (typeof model)[];
    defaultModel?: ModelSelection;
    loading?: boolean;
  } = {}
) {
  return renderToStaticMarkup(
    <ModelPicker
      availableModels={options.availableModels ?? [model]}
      defaultModel={options.defaultModel}
      loading={options.loading}
      onValueChange={() => undefined}
      value={value}
    />
  );
}

test("model picker announces the selected model and provider", () => {
  const markup = renderPicker("fixture/scripted");

  expect(markup).toContain(
    'aria-label="Choose model. Current selection: Scripted Model, Fixture Provider (fixture/scripted)."'
  );
});

test("model picker explains when no model is selected", () => {
  const markup = renderPicker("");

  expect(markup).toContain('aria-label="Choose model. No model selected."');
});

test("model picker announces that the catalog is loading", () => {
  const markup = renderPicker("", { loading: true });

  expect(markup).toContain(
    'aria-label="Choose model. Loading the model catalog."'
  );
});

test("model picker explains when a saved selection is unavailable", () => {
  const markup = renderPicker("fixture/retired", { availableModels: [] });

  expect(markup).toContain(
    'aria-label="Choose model. Saved selection fixture/retired is unavailable."'
  );
});

test("model picker announces the global default model", () => {
  const markup = renderPicker("default", {
    defaultModel: { modelID: "scripted", providerID: "fixture" },
  });

  expect(markup).toContain(
    'aria-label="Choose model. Current selection: Auto · Scripted Model. fixture/scripted."'
  );
});
