import { QueryClient } from "@tanstack/react-query";
import { shouldRetry } from "./errors";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetry } },
});
