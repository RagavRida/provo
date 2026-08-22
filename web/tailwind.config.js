/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Space Grotesk", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        provo: {
          bg: "#0b0d0f",
          surface: "#14171a",
          border: "#242830",
          text: "#e6e8eb",
          muted: "#8b929c",
          pass: "#2dd4a7",
          fail: "#f97350",
        },
      },
    },
  },
  plugins: [],
};
