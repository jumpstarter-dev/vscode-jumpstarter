/**
 * Pure logic for the Lease Templates view: no vscode imports, so everything
 * here is unit-testable under plain node (src/test/unit/leaseTemplates.test.ts).
 *
 * A lease template is a set of exporters that belong together (a head unit,
 * its phone and its ECU), each a **role**, which a lab administrator
 * published. Requesting it makes ONE lease that holds an exporter for every
 * role. The view lists the templates a client can request and what each is
 * made of; the provider (provider.ts) maps the rows built here onto
 * vscode.TreeItem objects.
 */

import { LeaseForward, LeaseTemplate, LeaseTemplateMember } from "../../types";
import { describeForward } from "../leases/members";

export interface TemplateRowDescriptor {
  id: string;
  label: string;
  description: string;
  tooltip: string;
  contextValue: string;
  icon: string;
  iconColor: string | undefined;
}

/** `phone*`: a role as the CLI writes it, with a star when it is optional. */
export function memberLabel(entry: LeaseTemplateMember): string {
  return entry.member.optional ? `${entry.member.name}*` : entry.member.name;
}

/** `headunit, phone*, ecu`: the roles of a template, in its order. */
export function describeMembers(template: LeaseTemplate): string {
  return template.members.map(memberLabel).join(", ");
}

/** How a role finds its exporter: a selector, or `exporter NAME`. */
export function memberSelection(entry: LeaseTemplateMember): string {
  return entry.member.exporter_name ? `exporter ${entry.member.exporter_name}` : (entry.member.selector ?? "");
}

/** `2/3`: the roles with at least one exporter that can be leased now, of all roles. Only a guide. */
export function availableSummary(template: LeaseTemplate): string {
  const available = template.members.filter((entry) => entry.available > 0).length;
  return `${available}/${template.members.length}`;
}

/**
 * Whether a lease from the template could be bound now, as far as the
 * numbers say: every role that is not optional has an exporter to lease.
 */
export function isAvailable(template: LeaseTemplate): boolean {
  return (
    template.members.length > 0 &&
    template.members.every((entry) => entry.member.optional === true || entry.available > 0)
  );
}

/** The optional roles of a template: the ones a request may leave out. */
export function optionalRoles(template: LeaseTemplate): LeaseTemplateMember[] {
  return template.members.filter((entry) => entry.member.optional === true);
}

/** `2h`, `1h30m`, `45s`: seconds as a duration `jmp --duration` reads. Empty for nothing. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  let rest = Math.round(seconds);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      rest -= count * size;
    }
  }
  return parts.join("");
}

/** The links of a template that are web addresses: only those are ever opened. */
export function docLinks(template: LeaseTemplate): string[] {
  return template.docs.filter((doc) => {
    try {
      const url = new URL(doc);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
}

/** The row of a template: its roles and how many can be leased now. */
export function buildTemplateRow(template: LeaseTemplate): TemplateRowDescriptor {
  const available = isAvailable(template);
  const tooltip = [template.name];
  if (template.description) {
    tooltip.push(template.description);
  }
  tooltip.push(`Roles: ${describeMembers(template) || "(none)"}`);
  tooltip.push(`Available: ${availableSummary(template)} roles have an exporter to lease now`);
  const duration = formatDuration(template.default_duration);
  if (duration) {
    tooltip.push(`Default duration: ${duration}`);
  }
  for (const forward of template.forwards) {
    tooltip.push(`Forward ${forward.name}: ${describeForward(forward)}`);
  }
  for (const doc of template.docs) {
    tooltip.push(`Docs: ${doc}`);
  }
  if (template.instructions) {
    tooltip.push("", template.instructions.trim());
  }
  return {
    id: `jumpstarter.leaseTemplate/${template.namespace}/${template.name}`,
    label: template.name,
    description: [describeMembers(template), `${availableSummary(template)} available`, template.description]
      .filter((part) => part.length > 0)
      .join(" · "),
    tooltip: tooltip.join("\n"),
    contextValue: "jumpstarterLeaseTemplate",
    icon: "layers",
    iconColor: available ? "charts.green" : "disabledForeground",
  };
}

/** The row of one role of a template. */
export function buildTemplateMemberRow(template: LeaseTemplate, entry: LeaseTemplateMember): TemplateRowDescriptor {
  const selection = memberSelection(entry);
  const tooltip = [
    `Role: ${entry.member.name}${entry.member.optional ? " (optional: a request may leave it out)" : ""}`,
  ];
  if (selection) {
    tooltip.push(`Selects: ${selection}`);
  }
  tooltip.push(`${entry.available} exporter${entry.available === 1 ? "" : "s"} you can lease now`);
  return {
    id: `jumpstarter.leaseTemplate/${template.namespace}/${template.name}/member/${entry.member.name}`,
    label: memberLabel(entry),
    description: [selection, `${entry.available} available`].filter((part) => part.length > 0).join(" · "),
    tooltip: tooltip.join("\n"),
    contextValue: "jumpstarterLeaseTemplateMember",
    icon: "server-environment",
    iconColor: entry.available > 0 ? "charts.green" : "disabledForeground",
  };
}

/** The row of one forward of a template: what a lease from it connects. */
export function buildTemplateForwardRow(template: LeaseTemplate, forward: LeaseForward): TemplateRowDescriptor {
  const endpoints = describeForward(forward);
  return {
    id: `jumpstarter.leaseTemplate/${template.namespace}/${template.name}/forward/${forward.name}`,
    label: forward.name,
    description: endpoints,
    tooltip: `Forward: ${forward.name}\nConnects: ${endpoints || "(no endpoints)"}\nA lease from this template has it.`,
    contextValue: "jumpstarterLeaseTemplateForward",
    icon: "plug",
    iconColor: undefined,
  };
}

/** The row of one documentation link of a template. */
export function buildTemplateDocRow(template: LeaseTemplate, link: string, index: number): TemplateRowDescriptor {
  return {
    id: `jumpstarter.leaseTemplate/${template.namespace}/${template.name}/doc/${index}`,
    label: link,
    description: "",
    tooltip: `Open ${link} in the browser`,
    contextValue: "jumpstarterLeaseTemplateDoc",
    icon: "link-external",
    iconColor: undefined,
  };
}

// ---------------------------------------------------------------------------
// Requesting a template
// ---------------------------------------------------------------------------

/** QuickPick presets for a lease from a template; the template's default and a Custom option are added. */
export const TEMPLATE_DURATION_CHOICES = ["30m", "1h", "2h", "4h", "8h"] as const;

export interface DurationChoice {
  label: string;
  description?: string;
  /** What `--duration` is given; undefined leaves it out, and the template's default applies. */
  duration?: string;
  /** The entry that asks for a duration of the user's own. */
  custom?: boolean;
}

export const CUSTOM_DURATION_LABEL = "Custom…";

/**
 * What to offer for the duration of a lease from a template. A template with
 * a default duration offers it first, and choosing it sends no `--duration`
 * at all (the default is the template's to change); one without has to be
 * given a duration.
 */
export function durationChoices(template: LeaseTemplate): DurationChoice[] {
  const choices: DurationChoice[] = [];
  const fallback = formatDuration(template.default_duration);
  if (fallback) {
    choices.push({ label: `Template default (${fallback})`, description: "what the template says" });
  }
  for (const duration of TEMPLATE_DURATION_CHOICES) {
    choices.push({ label: duration, duration });
  }
  choices.push({ label: CUSTOM_DURATION_LABEL, custom: true });
  return choices;
}

/** `ivi`, `ivi without phone`: what a request for a template is called while it is outstanding. */
export function requestLabel(template: string, without: readonly string[]): string {
  return without.length > 0 ? `${template} without ${without.join(", ")}` : template;
}

/** Templates by name, for a stable order. */
export function sortTemplates(templates: readonly LeaseTemplate[]): LeaseTemplate[] {
  return [...templates].sort((a, b) => a.name.localeCompare(b.name));
}
