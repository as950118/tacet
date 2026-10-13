"use client";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="panel error">
      <p>불러오지 못했습니다: {error.message}</p>
      <button onClick={reset}>다시 시도</button>
    </div>
  );
}
