"use client";

import { useEffect, useState } from "react";

const PARSING_STEPS = [
  { label: "Reading spreadsheet", icon: "📊", duration: 2000 },
  { label: "Detecting structure", icon: "🔍", duration: 3000 },
  { label: "Extracting products", icon: "📦", duration: 8000 },
  { label: "Matching catalog", icon: "🎯", duration: 5000 },
  { label: "Validating data", icon: "✓", duration: 3000 },
];

export function ParsingLoader() {
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const totalDuration = PARSING_STEPS.reduce((sum, s) => sum + s.duration, 0);
    let elapsed = 0;

    const interval = setInterval(() => {
      elapsed += 100;
      const newProgress = Math.min((elapsed / totalDuration) * 100, 95); // Cap at 95% until actually done
      setProgress(newProgress);

      // Calculate which step we should be on
      let cumulativeDuration = 0;
      for (let i = 0; i < PARSING_STEPS.length; i++) {
        cumulativeDuration += PARSING_STEPS[i].duration;
        if (elapsed < cumulativeDuration) {
          setCurrentStep(i);
          break;
        }
      }
    }, 100);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      {/* Animated icon */}
      <div className="relative mb-8">
        <div className="absolute inset-0 animate-ping rounded-full bg-blue-400 opacity-20" />
        <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-4xl shadow-lg">
          <span className="animate-bounce">{PARSING_STEPS[currentStep].icon}</span>
        </div>
      </div>

      {/* Current step */}
      <h3 className="mb-2 text-lg font-semibold text-gray-900">
        {PARSING_STEPS[currentStep].label}
      </h3>
      <p className="mb-6 text-sm text-gray-500">
        This usually takes 15-30 seconds...
      </p>

      {/* Progress bar */}
      <div className="w-full max-w-md">
        <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
          <span>Processing</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Steps list */}
      <div className="mt-8 w-full max-w-md space-y-2">
        {PARSING_STEPS.map((step, idx) => (
          <div
            key={idx}
            className={`flex items-center gap-3 rounded-lg px-4 py-2 transition-all ${
              idx === currentStep
                ? "bg-blue-50 text-blue-700"
                : idx < currentStep
                  ? "bg-white text-gray-400"
                  : "bg-white text-gray-300"
            }`}
          >
            <span className="text-xl">{step.icon}</span>
            <span className="flex-1 text-sm font-medium">{step.label}</span>
            {idx < currentStep && (
              <svg className="h-4 w-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {idx === currentStep && (
              <div className="h-4 w-4">
                <div className="h-full w-full animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Fun facts */}
      <div className="mt-8 rounded-lg bg-gray-50 px-4 py-3 text-center">
        <p className="text-xs text-gray-500">
          💡 <span className="font-medium">Did you know?</span> Our AI can handle messy spreadsheets
          with merged cells, unusual layouts, and even quantity tiers in headers.
        </p>
      </div>
    </div>
  );
}
