import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import { useMutation } from "@tanstack/react-query";

/** Changes the signed-in console user's own password (current session only). */
export function useChangePassword() {
  return useMutation<
    { status: "success" | "failed"; message?: string },
    ApiErrorShape,
    { currentPassword: string; newPassword: string }
  >({
    mutationFn: (request) =>
      consoleRequest<{ status: "success" | "failed"; message?: string }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(request),
      }),
  });
}
