import {
  workspaceMutationSchema,
  workspaceSnapshotSchema,
} from "@chorus/contracts";
import { proxyChorusJson } from "@/lib/chorus-serve";

export async function GET() {
  try {
    const response = await proxyChorusJson("/workspace", {
      method: "GET",
    });

    if (response.ok) {
      workspaceSnapshotSchema.parse(await response.clone().json());
    } else {
      console.error("Failed to fetch workspace snapshot:", {
        status: response.status,
        statusText: response.statusText,
      });
    }

    return response;
  } catch (error) {
    console.error("Failed to fetch workspace:", error);

    return new Response(
      JSON.stringify({
        code: "workspace_fetch_error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = workspaceMutationSchema.parse(await request.json());

    const response = await proxyChorusJson("/workspace/mutations", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.clone().text();
      console.error("Workspace mutation failed:", {
        status: response.status,
        statusText: response.statusText,
        mutationType: body.type,
        errorBody: errorText,
      });
    }

    return response;
  } catch (error) {
    console.error("Failed to process workspace mutation:", error);

    if (error instanceof Error) {
      return new Response(
        JSON.stringify({
          code: "mutation_processing_error",
          message: error.message,
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        code: "unknown_error",
        message: "An unexpected error occurred",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }
}
