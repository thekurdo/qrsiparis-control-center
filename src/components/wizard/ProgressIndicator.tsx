/**
 * ProgressIndicator — horizontal step dots with TR labels for the onboarding
 * wizard. Shows past steps as `bg-blue-600`, current as `bg-blue-500 ring`,
 * future as `bg-slate-700`.
 *
 * Pure visual; consumes `currentStep` (1-indexed) and `totalSteps`. Labels are
 * inlined here to keep the wizard self-contained — they map 1:1 to the step
 * components.
 */

const STEP_LABELS = [
  'Temel',
  'Anlaşma',
  'Domain',
  'Şablon',
  'Modüller',
  'Sunucu',
  'Onay',
];

export function ProgressIndicator({
  currentStep,
  totalSteps,
}: {
  currentStep: number;
  totalSteps: number;
}) {
  // Defensive: clamp so we never overflow the labels array even if the
  // caller passes a bigger totalSteps than we have copy for.
  const steps = STEP_LABELS.slice(0, totalSteps);

  return (
    <ol
      className="flex items-center gap-2 sm:gap-3 overflow-x-auto"
      aria-label="Wizard ilerlemesi"
    >
      {steps.map((label, idx) => {
        const stepNum = idx + 1;
        const isDone = stepNum < currentStep;
        const isCurrent = stepNum === currentStep;
        const isFuture = stepNum > currentStep;

        return (
          <li key={label} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                isDone
                  ? 'bg-blue-600 text-white'
                  : isCurrent
                    ? 'bg-blue-500 text-white ring-2 ring-blue-300/40'
                    : 'bg-slate-700 text-slate-400'
              }`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              {isDone ? (
                <span aria-hidden="true">{'✓'}</span>
              ) : (
                stepNum
              )}
            </div>
            <span
              className={`text-xs sm:text-sm ${
                isCurrent
                  ? 'text-slate-100 font-medium'
                  : isFuture
                    ? 'text-slate-500'
                    : 'text-slate-400'
              }`}
            >
              {label}
            </span>
            {idx < steps.length - 1 && (
              <span
                aria-hidden="true"
                className={`w-4 sm:w-6 h-px ${
                  isDone ? 'bg-blue-600' : 'bg-slate-700'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
