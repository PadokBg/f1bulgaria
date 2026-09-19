/**
 * Лаборатория за звука на двигателя: истинският sound.js + физическият
 * модел в браузъра, без Laravel и без Vite.
 *
 *   node scripts/game/engine-lab.mjs [--port=8777]
 *   → отвори http://127.0.0.1:8777 в истинския браузър (панелът в Claude
 *     Code не пуска звук)
 *
 * Страницата кара запис на обиколка (автопилот + трансмисията на играта)
 * или ръчни обороти/газ, превключва модел ↔ стар синтез и настройва модела
 * на живо. „Копирай настройките" дава JSON за V10_PRESET в engineWorklet.js.
 *
 * Слуша само на 127.0.0.1 и сервира само страницата, три модула от
 * resources/js/game и записите на обиколки — нищо друго от диска.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { recordLap } from './engine-render.mjs';

const portArgument = process.argv.find((arg) => arg.startsWith('--port='));
const port = portArgument ? Number(portArgument.slice(7)) : 8777;

const MODULES = new Set(['sound.js', 'drivetrain.js', 'engineWorklet.js']);
const TRACKS = new Set(['monza', 'spa', 'monaco', 'silverstone', 'suzuka', 'interlagos', 'bahrain']);
const laps = new Map();

const send = (response, status, type, body) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
};

createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
        send(response, 200, 'text/html; charset=utf-8', readFileSync(join('scripts', 'game', 'engine-lab.html')));

        return;
    }

    const moduleMatch = url.pathname.match(/^\/resources\/js\/game\/([A-Za-z]+\.js)$/);
    if (moduleMatch && MODULES.has(moduleMatch[1])) {
        send(response, 200, 'text/javascript; charset=utf-8', readFileSync(join('resources', 'js', 'game', moduleMatch[1])));

        return;
    }

    if (url.pathname === '/lap.json') {
        const track = url.searchParams.get('track') ?? 'monza';
        if (!TRACKS.has(track)) {
            send(response, 404, 'text/plain; charset=utf-8', 'Непозната писта');

            return;
        }
        if (!laps.has(track)) {
            laps.set(track, JSON.stringify(recordLap(track, 90)));
        }
        send(response, 200, 'application/json', laps.get(track));

        return;
    }

    send(response, 404, 'text/plain; charset=utf-8', 'Няма такова нещо');
}).listen(port, '127.0.0.1', () => {
    console.log(`Лабораторията е на http://127.0.0.1:${port} — отвори я в истинския браузър (Ctrl+C спира).`);
});
