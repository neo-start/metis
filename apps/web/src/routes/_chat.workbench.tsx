import { createFileRoute } from "@tanstack/react-router";
import { WorkbenchHome } from "~/components/WorkbenchHome";

export const Route = createFileRoute("/_chat/workbench")({ component: WorkbenchHome });
