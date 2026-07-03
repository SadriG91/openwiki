import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import { ensureOpenWikiHome, openWikiHomeDir } from "./openwiki-home.js";
import type { ConnectorId } from "./connectors/types.js";
import type { OpenWikiOnboardingConfig } from "./onboarding.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FIRST_HOUR = 2;

export type CronValidationResult =
  | {
      description: string;
      expression: string;
      valid: true;
    }
  | {
      error: string;
      expression: string;
      valid: false;
    };

export type ScheduleInstallResult = {
  description: string;
  expression: string;
  launchAgentPath?: string;
  warning?: string;
};

type CalendarInterval = Partial<
  Record<"Hour" | "Minute" | "Month" | "Day" | "Weekday", number>
>;

export function validateCronExpression(
  expression: string,
): CronValidationResult {
  const normalizedExpression = normalizeCronExpression(expression);

  if (!normalizedExpression) {
    return {
      error: "Enter a cron expression like 0 2 * * *.",
      expression: normalizedExpression,
      valid: false,
    };
  }

  try {
    CronExpressionParser.parse(normalizedExpression);
    return {
      description: describeCronExpression(normalizedExpression),
      expression: normalizedExpression,
      valid: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid cron schedule.",
      expression: normalizedExpression,
      valid: false,
    };
  }
}

export function describeCronExpression(expression: string): string {
  return cronstrue.toString(expression, {
    throwExceptionOnParseError: true,
    use24HourTimeFormat: false,
  });
}

export function getSuggestedCronExpression(
  config: OpenWikiOnboardingConfig,
): string {
  const usedHours = new Set<number>();

  for (const sourceConfig of Object.values(config.sources)) {
    const scheduleExpression = sourceConfig?.schedule?.expression;
    if (!scheduleExpression) {
      continue;
    }

    const hour = getSingleCronNumber(scheduleExpression.split(/\s+/u)[1], {
      max: 23,
      min: 0,
    });
    if (hour !== null) {
      usedHours.add(hour);
    }
  }

  for (let offset = 0; offset < 24; offset += 1) {
    const hour = (DEFAULT_FIRST_HOUR + offset) % 24;
    if (!usedHours.has(hour)) {
      return `0 ${hour} * * *`;
    }
  }

  return `0 ${DEFAULT_FIRST_HOUR} * * *`;
}

export async function installConnectorSchedule({
  connectorId,
  cronExpression,
  cwd,
}: {
  connectorId: ConnectorId;
  cronExpression: string;
  cwd: string;
}): Promise<ScheduleInstallResult> {
  const validation = validateCronExpression(cronExpression);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (process.platform !== "darwin") {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but native installation is currently macOS-only.",
    };
  }

  const calendarInterval = parseLaunchdCalendarInterval(validation.expression);
  if (!calendarInterval) {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but this cron expression is too complex for direct launchd installation.",
    };
  }

  const label = `com.openwiki.${toSafeLaunchdName(connectorId)}`;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const logsDir = path.join(openWikiHomeDir, "logs");
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);

  await ensureOpenWikiHome();
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath,
    createLaunchAgentPlist({
      calendarInterval,
      connectorId,
      cwd,
      label,
      logPath: path.join(logsDir, `${connectorId}.schedule.log`),
    }),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(plistPath, 0o600);

  const launchdDomain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
  await execFileAsync("launchctl", [
    "bootout",
    `${launchdDomain}/${label}`,
  ]).catch(() => null);
  await execFileAsync("launchctl", ["bootstrap", launchdDomain, plistPath]);

  return {
    description: validation.description,
    expression: validation.expression,
    launchAgentPath: plistPath,
  };
}

function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/gu, " ");
}

function parseLaunchdCalendarInterval(
  expression: string,
): CalendarInterval | null {
  const [minute, hour, day, month, weekday, ...extra] =
    expression.split(/\s+/u);
  if (!minute || !hour || !day || !month || !weekday || extra.length > 0) {
    return null;
  }

  const parsedMinute = getSingleCronNumber(minute, { max: 59, min: 0 });
  if (parsedMinute === null) {
    return null;
  }

  const interval: CalendarInterval = {
    Minute: parsedMinute,
  };

  const parsedHour = getSingleCronNumber(hour, { max: 23, min: 0 });
  if (parsedHour !== null) {
    interval.Hour = parsedHour;
  } else if (hour !== "*") {
    return null;
  }

  const parsedDay = getSingleCronNumber(day, { max: 31, min: 1 });
  if (parsedDay !== null) {
    interval.Day = parsedDay;
  } else if (day !== "*") {
    return null;
  }

  const parsedMonth = getSingleCronNumber(month, { max: 12, min: 1 });
  if (parsedMonth !== null) {
    interval.Month = parsedMonth;
  } else if (month !== "*") {
    return null;
  }

  const parsedWeekday = getSingleCronNumber(weekday, { max: 7, min: 0 });
  if (parsedWeekday !== null) {
    interval.Weekday = parsedWeekday === 7 ? 0 : parsedWeekday;
  } else if (weekday !== "*") {
    return null;
  }

  return interval;
}

function getSingleCronNumber(
  field: string | undefined,
  { max, min }: { max: number; min: number },
): number | null {
  if (!field || !/^\d+$/u.test(field)) {
    return null;
  }

  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function createLaunchAgentPlist({
  calendarInterval,
  connectorId,
  cwd,
  label,
  logPath,
}: {
  calendarInterval: CalendarInterval;
  connectorId: ConnectorId;
  cwd: string;
  label: string;
  logPath: string;
}): string {
  const cliPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const programArguments = [
    process.execPath,
    cliPath,
    "--update",
    "--print",
    `Refresh the wiki from the ${connectorId} connector.`,
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(cwd)}</string>
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StartCalendarInterval</key>
  <dict>
${Object.entries(calendarInterval)
  .map(
    ([key, value]) => `    <key>${key}</key>
    <integer>${value}</integer>`,
  )
  .join("\n")}
  </dict>
</dict>
</plist>
`;
}

function toSafeLaunchdName(value: string): string {
  return value.replace(/[^a-z0-9-]/giu, "-").toLowerCase();
}

function escapePlist(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
