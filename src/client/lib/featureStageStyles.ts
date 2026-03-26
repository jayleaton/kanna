import type { FeatureStage } from "../../shared/types"

export const FEATURE_STAGE_TINT_STYLES: Record<FeatureStage, string> = {
  idea: "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/12 dark:text-amber-200",
  todo: "border-sky-500/30 bg-sky-500/15 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/12 dark:text-sky-200",
  progress: "border-indigo-500/30 bg-indigo-500/15 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/12 dark:text-indigo-200",
  testing: "border-cyan-500/30 bg-cyan-500/15 text-cyan-700 dark:border-cyan-500/40 dark:bg-cyan-500/12 dark:text-cyan-200",
  done: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/12 dark:text-emerald-200",
}
