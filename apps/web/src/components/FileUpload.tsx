"use client";

import { useCallback, useRef, useState, useEffect } from "react";

interface FileUploadProps {
  onUpload: (file: File, notes: string, maxRounds: number) => void;
  isLoading: boolean;
}

const loadingSteps = [
  { label: "Reading spreadsheet", duration: 2000 },
  { label: "Extracting products", duration: 2500 },
  { label: "Matching catalog", duration: 2000 },
  { label: "Validating data", duration: 1500 },
];

export function FileUpload({ onUpload, isLoading }: FileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [maxRounds, setMaxRounds] = useState(4);
  const [dragOver, setDragOver] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Simulate loading progress
  useEffect(() => {
    if (!isLoading) {
      setCurrentStep(0);
      setProgress(0);
      return;
    }

    let progressTimer: NodeJS.Timeout;

    const totalDuration = loadingSteps.reduce((sum, step) => sum + step.duration, 0);
    const startTime = Date.now();

    const updateProgress = () => {
      const elapsed = Date.now() - startTime;
      const newProgress = Math.min((elapsed / totalDuration) * 100, 95);
      setProgress(newProgress);

      let accumulatedTime = 0;
      for (let i = 0; i < loadingSteps.length; i++) {
        accumulatedTime += loadingSteps[i].duration;
        if (elapsed < accumulatedTime) {
          setCurrentStep(i);
          break;
        }
      }

      if (elapsed < totalDuration) {
        progressTimer = setTimeout(updateProgress, 50);
      }
    };

    updateProgress();

    return () => {
      clearTimeout(progressTimer);
    };
  }, [isLoading]);

  const handleFile = useCallback((f: File) => {
    if (
      f.type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      f.name.endsWith(".xlsx")
    ) {
      setFile(f);
    } else {
      alert("Please upload an XLSX file");
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) handleFile(droppedFile);
    },
    [handleFile]
  );

  const handleSubmit = () => {
    if (file) onUpload(file, notes, maxRounds);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 py-8">
        {/* Main loading animation */}
        <div className="flex flex-col items-center justify-center space-y-6">
          <div className="relative">
            <div className="h-24 w-24 rounded-full border-4 border-gray-200" />
            <div
              className="absolute inset-0 h-24 w-24 rounded-full border-4 border-blue-500 border-t-transparent animate-spin"
              style={{ animationDuration: "1s" }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <svg className="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
          </div>

          <div className="text-center">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {loadingSteps[currentStep].label}
            </h3>
            <p className="text-sm text-gray-500">
              Analyzing your quotation...
            </p>
          </div>
        </div>

        {/* Progress bar */}
        <div className="space-y-2">
          <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-400">
            <span>{Math.round(progress)}%</span>
            <span>~{Math.ceil((100 - progress) / 12)}s remaining</span>
          </div>
        </div>

        {/* Step indicators */}
        <div className="grid grid-cols-4 gap-2">
          {loadingSteps.map((step, idx) => (
            <div
              key={idx}
              className={`flex flex-col items-center space-y-1 p-2 rounded-lg transition-all ${
                idx === currentStep
                  ? "bg-blue-50 border border-blue-200"
                  : idx < currentStep
                    ? "bg-green-50 border border-green-200"
                    : "bg-gray-50 border border-gray-200"
              }`}
            >
              <div className="h-6 w-6 flex items-center justify-center">
                {idx < currentStep ? (
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className={`h-2 w-2 rounded-full ${
                    idx === currentStep ? "bg-blue-500" : "bg-gray-300"
                  }`} />
                )}
              </div>
              <span className={`text-[10px] font-medium text-center ${
                idx === currentStep
                  ? "text-blue-700"
                  : idx < currentStep
                    ? "text-green-700"
                    : "text-gray-400"
              }`}>
                {step.label}
              </span>
            </div>
          ))}
        </div>

        {/* Fun fact */}
        <div className="rounded-lg bg-gradient-to-br from-gray-50 to-gray-100 border border-gray-200 p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-1">About Amber</p>
              <p className="text-xs text-gray-600 leading-relaxed">
                {currentStep === 0 && "Amber is an AI-native operating system built for ambitious brands with global supply chains. From concept to shelf, all in one platform."}
                {currentStep === 1 && "Brands using AmberOS™ can reduce product cycle time by up to 40%, turning months into weeks through intelligent automation."}
                {currentStep === 2 && "AmberOS™ replaces endless email threads and spreadsheet chaos with a unified platform that handles prototyping, POs, freight, and customs."}
                {currentStep === 3 && "Amber helps brands save on FX (up to 70% on international wires), freight rates, and optimize tariffs — all while streamlining operations."}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-12 text-center transition-all ${
          dragOver
            ? "border-blue-500 bg-blue-50 scale-105"
            : file
              ? "border-green-400 bg-green-50"
              : "border-gray-300 bg-white hover:border-gray-400 hover:bg-gray-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <div className="flex flex-col items-center space-y-3">
          {file ? (
            <>
              <div className="rounded-full bg-green-100 p-3">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <p className="text-green-700 font-semibold text-lg">{file.name}</p>
                <p className="text-green-600 text-sm mt-1">{(file.size / 1024).toFixed(1)} KB • Ready to process</p>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-full bg-gray-100 p-4">
                <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <div>
                <p className="text-gray-700 font-semibold text-lg">Drop your quotation here</p>
                <p className="text-gray-500 text-sm mt-1">or click to browse • XLSX files only</p>
              </div>
            </>
          )}
        </div>
      </div>

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder='Notes (e.g. "prioritize lead time, 30 day max")'
        className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100 transition-all"
        rows={2}
      />

      <div>
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 block">
          Quick presets
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[
            "Prioritize lead time, 30 day max",
            "Lowest cost, quality can flex",
            "Best quality, willing to pay premium",
            "Optimize cash flow, prefer split terms",
            "Balance cost and quality, 45 day lead max",
          ].map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => setNotes(prompt)}
              className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:border-gray-900 hover:bg-gray-900 hover:text-white transition-all"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700 whitespace-nowrap">Max rounds</label>
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setMaxRounds(n)}
              className={`w-10 h-10 rounded-lg text-sm font-semibold transition-all ${
                maxRounds === n
                  ? "bg-gray-900 text-white shadow-md scale-110"
                  : "border border-gray-300 bg-white text-gray-700 hover:border-gray-900 hover:bg-gray-50"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-500">per supplier</span>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!file || isLoading}
        className="w-full rounded-lg bg-gradient-to-r from-gray-900 to-gray-800 px-4 py-3 font-semibold text-white hover:from-gray-800 hover:to-gray-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:from-gray-900 disabled:hover:to-gray-800 transition-all shadow-md hover:shadow-lg"
      >
        {isLoading ? "Processing..." : "Start Quoting"}
      </button>
    </div>
  );
}
