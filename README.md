# ITinder

Три приложения работают на одном сервере:

| Приложение | Адрес | Сборка |
| --- | --- | --- |
| `app` — станция и API | `/app/web/` (главная `/` перенаправляет сюда) | браузерные ES-модули |
| `resume3` — 3D-комната | `/resume3/` | `resume3/public/` |
| `portfolio-inner-site` — рабочий стол внутри iframe комнаты | `/os/` | `portfolio-inner-site/build/` |

Единый origin сохраняет доступ iframe к API и общей браузерной сессии. Все пути обслуживает `app/tools/serve.py`.

## Запуск

Для локальной разработки: Python 3.13 и Node.js 22.

```powershell
python -m pip install -r app/tools/requirements.txt
cd portfolio-inner-site
npm ci --no-audit --no-fund
npm run build
cd ../resume3
npm ci --no-audit --no-fund
npm run build
cd ..
python app/tools/serve.py 8000
```

Откройте `http://127.0.0.1:8000/`. Для распознавания резюме и проверки заданий установите `GEMINI_API_KEY` и/или `DEEPSEEK_API_KEY` в окружении процесса или локальном `.env.local`. `.env.local` также используется инструментами обмена с Supabase и не публикуется.

## Docker и Northflank

Корневой `Dockerfile` собирает обе внутренние страницы и запускает общий Python-сервер на `0.0.0.0:8080`. Node.js требуется только на этапе сборки.

```sh
docker build -t itinder .
docker run --rm -p 8080:8080 -v itinder-data:/data --env-file .env.local itinder
```

В Northflank создайте Combined service из `Evsikoff/itinder`, ветка `main`, Dockerfile `/Dockerfile`, build context `/`. Порт `8080` публикуется как HTTP, Northflank предоставляет HTTPS. Для сборки `resume3` нужно не менее 4 ГБ RAM; приложение работает в одном экземпляре. Подключите постоянный диск к `/data`, чтобы регистрации и остальные записи сохранялись при перезапусках и новых развёртываниях.

Переменные окружения: `HOST=0.0.0.0`, `PORT=8080`, `APP_DATA_DIR=/data`; ключи `GEMINI_API_KEY` и `DEEPSEEK_API_KEY` хранятся в Northflank Runtime variables/Secrets. При необходимости задайте `PUBLIC_ORIGIN` равным публичному HTTPS-адресу без завершающего слеша. Проверка готовности: `GET /healthz`.

Локальные пользовательские записи, секреты, `node_modules` и результаты сборки исключены из Git и Docker build context. Справочники и медиа входят в образ; новые пользовательские записи создаются на постоянном диске.
