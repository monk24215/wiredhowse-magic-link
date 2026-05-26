export function renderErrorHtml(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — wiredHowse Auth</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#111}
    h1{font-size:1.4rem;font-weight:600;margin:0 0 12px}
    p{color:#555;margin:0 0 20px;line-height:1.55}
    a{color:#0066cc}
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p>${message}</p>
</body>
</html>`;
}
