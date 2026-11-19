import { RepositoryRegistryError } from "../../projects/repository-registry";

export function mapRepositoryRegistryError(error: unknown) {
  if (!(error instanceof RepositoryRegistryError)) {
    return null;
  }

  return {
    status: error.code === "unregistered_repository_root" ? 403 : 400,
    code: error.code,
    message: error.message,
  };
}
