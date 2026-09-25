export const LOCATION_FORMULA_VERSION = "v1";
export const LOCATION_GOAL_TYPES = [
  "membership_conversion_rate",
  "new_membership_sales",
  "active_memberships",
  "gross_location_revenue",
  "weekly_churn_rate",
] as const;
export type LocationGoalType = typeof LOCATION_GOAL_TYPES[number];

export type CanonicalReportInput = {
  weekStart: string;
  timezoneSnapshot: string;
  beginningActiveMemberships: number;
  endingActiveMemberships: number;
  newMembershipSales: number;
  retailLaneCars: number;
  cancellationsDuringPeriod: number;
  grossLocationRevenueMinor: number;
  currency: string;
  notes: string;
  sourceType: string;
  sourceReference?: string | null;
};

export function httpError(message: string, statusCode = 400, code = "invalid_request") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function strictNonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw httpError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function requireText(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw httpError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw httpError(`${label} is too long`);
  return normalized;
}

export function optionalText(value: unknown, max: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw httpError("Text value is invalid");
  if (value.length > max) throw httpError("Text value is too long");
  return value.trim();
}

export function isMonday(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}

export function addUtcDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validateTimezone(value: unknown) {
  const timezone = requireText(value, "Timezone snapshot", 100);
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw httpError("Timezone snapshot must be a valid IANA timezone"); }
  return timezone;
}

export function validateCurrency(value: unknown) {
  const currency = requireText(value, "Currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw httpError("Currency must be a three-letter code");
  return currency;
}

export function parseCanonicalReportInput(body: any): CanonicalReportInput {
  const weekStart = requireText(body?.weekStart, "Week Start", 10);
  if (!isMonday(weekStart)) throw httpError("Week Start must be a valid Monday");
  return {
    weekStart,
    timezoneSnapshot: validateTimezone(body?.timezoneSnapshot),
    beginningActiveMemberships: strictNonNegativeInteger(body?.beginningActiveMemberships, "Beginning Active Memberships"),
    endingActiveMemberships: strictNonNegativeInteger(body?.endingActiveMemberships, "Ending Active Memberships"),
    newMembershipSales: strictNonNegativeInteger(body?.newMembershipSales, "New Membership Sales"),
    retailLaneCars: strictNonNegativeInteger(body?.retailLaneCars, "Retail Lane Cars"),
    cancellationsDuringPeriod: strictNonNegativeInteger(body?.cancellationsDuringPeriod, "Cancellations During Period"),
    grossLocationRevenueMinor: strictNonNegativeInteger(body?.grossLocationRevenueMinor, "Gross Location Revenue"),
    currency: validateCurrency(body?.currency),
    notes: optionalText(body?.notes, 4000),
    sourceType: requireText(body?.sourceType, "Source type", 80),
    sourceReference: optionalText(body?.sourceReference, 500) || null,
  };
}

export function deriveLocationMetrics(report: {
  new_membership_sales?: unknown; newMembershipSales?: unknown;
  retail_lane_cars?: unknown; retailLaneCars?: unknown;
  cancellations_during_period?: unknown; cancellationsDuringPeriod?: unknown;
  beginning_active_memberships?: unknown; beginningActiveMemberships?: unknown;
  ending_active_memberships?: unknown; endingActiveMemberships?: unknown;
  gross_location_revenue_minor?: unknown; grossLocationRevenueMinor?: unknown;
}) {
  const sales = Number(report.new_membership_sales ?? report.newMembershipSales);
  const cars = Number(report.retail_lane_cars ?? report.retailLaneCars);
  const cancellations = Number(report.cancellations_during_period ?? report.cancellationsDuringPeriod);
  const beginning = Number(report.beginning_active_memberships ?? report.beginningActiveMemberships);
  return {
    membershipConversionRate: cars === 0 ? null : sales / cars,
    weeklyChurnRate: beginning === 0 ? null : cancellations / beginning,
    activeMemberships: Number(report.ending_active_memberships ?? report.endingActiveMemberships),
    newMembershipSales: sales,
    retailLaneCars: cars,
    weeklyEarningsMinor: Number(report.gross_location_revenue_minor ?? report.grossLocationRevenueMinor),
  };
}

export function mean(values: Array<number | null>) {
  if (!values.length || values.some((value) => value === null || !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

export function relativeDifference(current: number | null, average: number | null) {
  if (current === null || average === null || average === 0) return null;
  return (current - average) / average;
}

export function summarizeAverage(currentReport: any, precedingReports: any[], requiredCount: number) {
  if (!Number.isInteger(requiredCount) || requiredCount < 2 || requiredCount > 52) {
    throw httpError("Average period must be between 2 and 52");
  }
  const progress = precedingReports.length;
  if (progress < requiredCount) return { available: false, requiredCount, completedCount: progress };
  const current = deriveLocationMetrics(currentReport);
  const prior = precedingReports.slice(0, requiredCount).map(deriveLocationMetrics);
  const keys = Object.keys(current) as Array<keyof typeof current>;
  const metrics: Record<string, any> = {};
  for (const key of keys) {
    const average = mean(prior.map((item) => item[key]));
    metrics[key] = {
      current: current[key],
      average,
      relativeDifference: relativeDifference(current[key], average),
    };
  }
  return { available: true, requiredCount, completedCount: progress, metrics };
}

export function validateGoal(goalType: unknown, value: unknown, currency?: unknown) {
  if (goalType === "retail_lane_cars") throw httpError("Retail Lane Cars has no V1 goal", 400, "goal_not_allowed");
  if (!LOCATION_GOAL_TYPES.includes(goalType as LocationGoalType)) throw httpError("Goal type is not supported");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw httpError("Goal value must be a non-negative number");
  if ((goalType === "new_membership_sales" || goalType === "active_memberships" || goalType === "gross_location_revenue") && !Number.isSafeInteger(value)) {
    throw httpError("Count and revenue goals must use integer units");
  }
  if ((goalType === "membership_conversion_rate" || goalType === "weekly_churn_rate") && value > 1) {
    throw httpError("Rate goals must be expressed between 0 and 1");
  }
  const normalizedCurrency = goalType === "gross_location_revenue" ? validateCurrency(currency) : null;
  return { goalType: goalType as LocationGoalType, value, currency: normalizedCurrency };
}

export function parseAverageCount(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value > 52) {
    throw httpError("Average period must be an integer from 2 to 52");
  }
  return value;
}
