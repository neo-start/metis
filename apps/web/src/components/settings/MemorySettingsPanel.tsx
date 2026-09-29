// FILE: MemorySettingsPanel.tsx
// Purpose: Review and edit Metis long-term memory: soul.md plus global and per-project memories
//          that every provider session reads, and that agents write through synara_memory_*.
// Layer: Settings UI components
// Exports: MemorySettingsPanel

import {
  METIS_MEMORY_BODY_MAX_BYTES,
  METIS_MEMORY_DESCRIPTION_MAX_CHARS,
  METIS_MEMORY_INJECTED_SOUL_MAX_BYTES,
  METIS_MEMORY_NAME_MAX_LENGTH,
  METIS_MEMORY_NAME_PATTERN,
  METIS_MEMORY_SOUL_MAX_BYTES,
  ProjectId,
  type MetisMemoryEntry,
  type MetisMemoryScope,
  type MetisMemoryType,
} from "@synara/contracts";
import { formatBytes } from "@synara/shared/formatBytes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";

import { ComposerPickerSelectPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import {
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
  SettingsCard,
} from "./SettingsPanelPrimitives";

const MEMORY_OVERVIEW_QUERY_KEY = ["metisMemory", "overview"] as const;
const GLOBAL_SCOPE_KEY = "global";
const MEMORY_NAME_REGEX = new RegExp(METIS_MEMORY_NAME_PATTERN);

const MEMORY_TYPE_OPTIONS: ReadonlyArray<{ value: MetisMemoryType; label: string }> = [
  { value: "user", label: "User" },
  { value: "feedback", label: "Feedback" },
  { value: "project", label: "Project" },
  { value: "reference", label: "Reference" },
];

function errorDescription(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function updatedAgo(iso: string): string {
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "just now" : `${relative} ago`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What the memory editor dialog is editing: a new memory or an existing one. */
type MemoryEditorTarget =
  | { mode: "create"; scope: MetisMemoryScope; projectId: ProjectId | null }
  | { mode: "edit"; entry: MetisMemoryEntry };

export function MemorySettingsPanel() {
  const queryClient = useQueryClient();
  const storeProjects = useStore((store) => store.projects);
  const [soulDraft, setSoulDraft] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<MemoryEditorTarget | null>(null);
  const [openingPath, setOpeningPath] = useState(false);

  const overviewQuery = useQuery({
    queryKey: MEMORY_OVERVIEW_QUERY_KEY,
    queryFn: () => ensureNativeApi().memory.getOverview(),
    staleTime: 5_000,
  });
  const overview = overviewQuery.data;
  const savedSoul = overview?.soul.content ?? "";
  const soulValue = soulDraft ?? savedSoul;
  const soulDirty = soulDraft !== null && soulDraft !== savedSoul;
  const soulBytes = utf8Bytes(soulValue);

  const projectTitles = useMemo(
    () => new Map(storeProjects.map((project) => [project.id, project.name])),
    [storeProjects],
  );
  const projectLabel = (projectId: string, recordedTitle: string | null) =>
    projectTitles.get(ProjectId.makeUnsafe(projectId)) ?? recordedTitle ?? projectId;

  const invalidateOverview = () =>
    queryClient.invalidateQueries({ queryKey: MEMORY_OVERVIEW_QUERY_KEY });

  const saveSoulMutation = useMutation({
    mutationFn: (content: string) => ensureNativeApi().memory.updateSoul({ content }),
    onSuccess: () => {
      setSoulDraft(null);
      void invalidateOverview();
      toastManager.add({
        type: "success",
        title: "Soul saved",
        description: "New sessions in every provider will read it.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save soul.md",
        description: errorDescription(error, "Saving failed."),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: (entry: MetisMemoryEntry) =>
      ensureNativeApi().memory.delete({
        scope: entry.scope,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        name: entry.name,
      }),
    onSuccess: () => {
      void invalidateOverview();
      toastManager.add({ type: "success", title: "Memory deleted" });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not delete memory",
        description: errorDescription(error, "Deleting failed."),
      }),
  });

  const confirmDelete = async (entry: MetisMemoryEntry) => {
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      `Delete memory "${entry.name}"?\n\nNew agent sessions will stop seeing it. This removes the file from disk.`,
    );
    if (confirmed) deleteMutation.mutate(entry);
  };

  const openPath = (targetPath: string) => {
    setOpeningPath(true);
    void openInPreferredEditor(ensureNativeApi(), targetPath)
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not open folder",
          description: errorDescription(error, "No available editors found."),
        }),
      )
      .finally(() => setOpeningPath(false));
  };

  const renderEntries = (entries: ReadonlyArray<MetisMemoryEntry>, emptyText: string) =>
    entries.length === 0 ? (
      <SettingsListRow title="No memories yet" description={emptyText} />
    ) : (
      entries.map((entry) => (
        <SettingsListRow
          key={entry.path}
          align="start"
          title={<span className="font-mono">{entry.name}</span>}
          description={
            <div className="space-y-0.5">
              <div>{entry.description || "No description"}</div>
              <div className="text-ui-xs text-muted-foreground/80">
                {entry.type} · updated {updatedAgo(entry.updatedAt)} ·{" "}
                {formatBytes(entry.sizeBytes)}
              </div>
            </div>
          }
          actions={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => setEditorTarget({ mode: "edit", entry })}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={deleteMutation.isPending}
                onClick={() => void confirmDelete(entry)}
              >
                Delete
              </Button>
            </div>
          }
        />
      ))
    );

  if (overviewQuery.isLoading) {
    return <SettingsEmptyState layout="status">Loading memory…</SettingsEmptyState>;
  }
  if (overviewQuery.isError || !overview) {
    return (
      <SettingsEmptyState layout="status" tone="destructive">
        {errorDescription(overviewQuery.error, "Metis memory is unavailable on this server.")}
      </SettingsEmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Location">
        <SettingsRow
          title="Memory folder"
          description="Plain markdown files you can edit directly. Changes apply to new provider sessions."
          status={
            <span className="block break-all font-mono text-ui-sm text-foreground">
              {overview.rootDir}
            </span>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={openingPath}
              onClick={() => openPath(overview.rootDir)}
            >
              {openingPath ? "Opening..." : "Open folder"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Soul">
        <SettingsRow
          title="soul.md"
          description={`Who Metis is for you: identity, tone, and working style. Every provider session reads the first ${formatBytes(METIS_MEMORY_INJECTED_SOUL_MAX_BYTES)}. Agents never edit it.`}
          status={
            overview.soul.updatedAt
              ? `Saved ${updatedAgo(overview.soul.updatedAt)} · ${formatBytes(soulBytes)}`
              : "Not written yet."
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                disabled={!soulDirty || saveSoulMutation.isPending}
                onClick={() => setSoulDraft(null)}
              >
                Revert
              </Button>
              <Button
                size="xs"
                disabled={
                  !soulDirty ||
                  saveSoulMutation.isPending ||
                  soulBytes > METIS_MEMORY_SOUL_MAX_BYTES
                }
                onClick={() => saveSoulMutation.mutate(soulValue)}
              >
                {saveSoulMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          }
        >
          <Textarea
            value={soulValue}
            aria-label="soul.md"
            placeholder={
              "Example:\nYou are my long-term engineering partner. Be direct, explain trade-offs briefly, and prefer small, verified changes."
            }
            spellCheck={false}
            className="mt-3 [&_[data-slot=textarea]]:min-h-40 [&_[data-slot=textarea]]:resize-y"
            onChange={(event) => setSoulDraft(event.target.value)}
          />
          {soulBytes > METIS_MEMORY_SOUL_MAX_BYTES ? (
            <p className="mt-2 text-ui-sm text-destructive">
              soul.md is limited to {formatBytes(METIS_MEMORY_SOUL_MAX_BYTES)}.
            </p>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSectionShell
        title="Global memories"
        action={
          <Button
            size="xs"
            variant="outline"
            onClick={() => setEditorTarget({ mode: "create", scope: "global", projectId: null })}
          >
            New memory
          </Button>
        }
      >
        <SettingsCard>
          {renderEntries(
            overview.global,
            "Agents save durable preferences and corrections here as they learn them.",
          )}
        </SettingsCard>
      </SettingsSectionShell>

      {overview.projects.length === 0 ? (
        <SettingsSectionShell title="Project memories">
          <SettingsEmptyState layout="status">
            No project memories yet. Agents save project facts to the project they are working in.
          </SettingsEmptyState>
        </SettingsSectionShell>
      ) : (
        overview.projects.map((group) => (
          <SettingsSectionShell
            key={group.projectId}
            title={projectLabel(group.projectId, group.projectTitle)}
            action={
              <Button
                size="xs"
                variant="ghost"
                disabled={openingPath}
                onClick={() => openPath(group.directory)}
              >
                Open folder
              </Button>
            }
          >
            <SettingsCard>
              {renderEntries(group.entries, "Agents save facts about this project here.")}
            </SettingsCard>
          </SettingsSectionShell>
        ))
      )}

      <Dialog
        open={editorTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditorTarget(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          {editorTarget ? (
            <MemoryEditorForm
              target={editorTarget}
              projects={storeProjects.map((project) => ({ id: project.id, name: project.name }))}
              onDone={() => {
                setEditorTarget(null);
                void invalidateOverview();
              }}
              onCancel={() => setEditorTarget(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function MemoryEditorForm(props: {
  target: MemoryEditorTarget;
  projects: ReadonlyArray<{ id: ProjectId; name: string }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { target } = props;
  const editing = target.mode === "edit" ? target.entry : null;
  const fieldId = useId();
  const [scopeKey, setScopeKey] = useState<string>(
    editing
      ? (editing.projectId ?? GLOBAL_SCOPE_KEY)
      : target.mode === "create" && target.projectId
        ? target.projectId
        : GLOBAL_SCOPE_KEY,
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [type, setType] = useState<MetisMemoryType>(editing?.type ?? "user");
  const [body, setBody] = useState<string | null>(editing ? null : "");

  const documentQuery = useQuery({
    queryKey: ["metisMemory", "document", editing?.path ?? null],
    queryFn: () =>
      ensureNativeApi().memory.read({
        scope: editing!.scope,
        ...(editing!.projectId ? { projectId: editing!.projectId } : {}),
        name: editing!.name,
      }),
    enabled: editing !== null,
    staleTime: 0,
  });
  useEffect(() => {
    if (body === null && documentQuery.data) setBody(documentQuery.data.body);
  }, [body, documentQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      ensureNativeApi().memory.write({
        scope: scopeKey === GLOBAL_SCOPE_KEY ? "global" : "project",
        ...(scopeKey === GLOBAL_SCOPE_KEY ? {} : { projectId: ProjectId.makeUnsafe(scopeKey) }),
        name,
        description: description.trim(),
        type,
        body: body ?? "",
      }),
    onSuccess: () => {
      toastManager.add({ type: "success", title: "Memory saved" });
      props.onDone();
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not save memory",
        description: errorDescription(error, "Saving failed."),
      }),
  });

  const bodyValue = body ?? "";
  const nameValid = MEMORY_NAME_REGEX.test(name);
  const bodyBytes = utf8Bytes(bodyValue);
  const canSave =
    nameValid &&
    description.trim().length > 0 &&
    bodyValue.trim().length > 0 &&
    bodyBytes <= METIS_MEMORY_BODY_MAX_BYTES &&
    body !== null &&
    !saveMutation.isPending;
  const scopeLabel =
    scopeKey === GLOBAL_SCOPE_KEY
      ? "Global"
      : (props.projects.find((project) => project.id === scopeKey)?.name ?? scopeKey);

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) saveMutation.mutate();
      }}
    >
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>{editing ? `Edit ${editing.name}` : "New memory"}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="space-y-4 px-5">
        {editing ? null : (
          <div className="space-y-2">
            <span id={`${fieldId}-scope`} className={cn("block", dialogFieldLabelClassName)}>
              Scope
            </span>
            <Select
              value={scopeKey}
              onValueChange={(next) => {
                if (typeof next === "string") setScopeKey(next);
              }}
            >
              <SelectTrigger aria-labelledby={`${fieldId}-scope`} className="w-full">
                <SelectValue>{scopeLabel}</SelectValue>
              </SelectTrigger>
              <ComposerPickerSelectPopup align="start">
                <SelectItem value={GLOBAL_SCOPE_KEY}>Global</SelectItem>
                {props.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </ComposerPickerSelectPopup>
            </Select>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <label className="space-y-2">
            <span className={cn("block", dialogFieldLabelClassName)}>Name</span>
            <Input
              value={name}
              disabled={editing !== null}
              maxLength={METIS_MEMORY_NAME_MAX_LENGTH}
              placeholder="prefers-small-diffs"
              spellCheck={false}
              aria-invalid={name.length > 0 && !nameValid ? true : undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="space-y-2">
            <span id={`${fieldId}-type`} className={cn("block", dialogFieldLabelClassName)}>
              Type
            </span>
            <Select
              value={type}
              onValueChange={(next) => {
                const option = MEMORY_TYPE_OPTIONS.find((candidate) => candidate.value === next);
                if (option) setType(option.value);
              }}
            >
              <SelectTrigger aria-labelledby={`${fieldId}-type`} className="w-full">
                <SelectValue>
                  {MEMORY_TYPE_OPTIONS.find((option) => option.value === type)?.label}
                </SelectValue>
              </SelectTrigger>
              <ComposerPickerSelectPopup align="start">
                {MEMORY_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </ComposerPickerSelectPopup>
            </Select>
          </div>
        </div>
        {name.length > 0 && !nameValid ? (
          <p className="text-ui-xs text-destructive">
            Use lowercase letters, digits, &quot;-&quot; or &quot;_&quot;, starting with a letter or
            digit.
          </p>
        ) : null}
        <label className="block space-y-2">
          <span className={cn("block", dialogFieldLabelClassName)}>Description</span>
          <Input
            value={description}
            maxLength={METIS_MEMORY_DESCRIPTION_MAX_CHARS}
            placeholder="One line every session sees in its memory index"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="block space-y-2">
          <span className={cn("block", dialogFieldLabelClassName)}>Memory</span>
          <Textarea
            value={bodyValue}
            disabled={body === null}
            placeholder={body === null ? "Loading…" : "The fact, and why it matters."}
            spellCheck={false}
            className="[&_[data-slot=textarea]]:min-h-40 [&_[data-slot=textarea]]:resize-y"
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {documentQuery.isError ? (
          <p className="text-ui-xs text-destructive">
            {errorDescription(documentQuery.error, "Could not load this memory.")}
          </p>
        ) : bodyBytes > METIS_MEMORY_BODY_MAX_BYTES ? (
          <p className="text-ui-xs text-destructive">
            A memory body is limited to {formatBytes(METIS_MEMORY_BODY_MAX_BYTES)}.
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter className="px-5 pb-5">
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saveMutation.isPending ? "Saving..." : "Save memory"}
        </Button>
      </DialogFooter>
    </form>
  );
}
