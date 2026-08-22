// Single-mark logo: a shield with a checkmark, in the "verified" teal accent.
export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M16 2L27 6.5V15C27 22.5 22.2 27.9 16 30C9.8 27.9 5 22.5 5 15V6.5L16 2Z"
        stroke="#2dd4a7"
        strokeWidth="2"
        fill="none"
      />
      <path d="M10.5 15.5L14 19L21.5 11" stroke="#2dd4a7" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
