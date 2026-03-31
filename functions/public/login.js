document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("loginForm");
  const err = document.getElementById("err");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";

    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());

    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        err.textContent = data.error || "Erro no login";
        return;
      }

      // ✅ Redirecionar conforme o role
      if (data.role === "admin") {
        window.location.href = "/admin#produtos";
      } else if (data.role === "worker") {
        window.location.href = "/worker.html";
      } else {
        // fallback de segurança
        window.location.href = "/";
      }

    } catch (e) {
      console.error("Erro no login:", e);
      err.textContent = "Erro de ligação ao servidor.";
    }
  });
});