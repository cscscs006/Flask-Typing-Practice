from flask import Flask, render_template, send_file, abort
from pathlib import Path

BASE = Path(__file__).resolve().parent

app = Flask(
    __name__,
    template_folder=str(BASE / "templates")
)

def _serve(subdir: str, filename: str):
    path = BASE / subdir / filename
    if path.exists() and path.is_file():
        return send_file(path)
    abort(404)

# ===== 页面路由 =====
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/liuyan")
def liuyan():
    return render_template("liuyan.html")

# ===== 静态资源路由（逐目录精确映射）=====
@app.route("/css/<path:filename>")
def serve_css(filename):
    return _serve("css", filename)

@app.route("/js/<path:filename>")
def serve_js(filename):
    return _serve("js", filename)

@app.route("/img/<path:filename>")
def serve_img(filename):
    return _serve("img", filename)

@app.route("/static/<path:filename>")
def serve_static_json(filename):
    return _serve("static", filename)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
