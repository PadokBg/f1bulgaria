<script setup>
import PublicLayout from '@/Layouts/PublicLayout.vue';
import GameLobbyHero from '@/Components/Game/GameLobbyHero.vue';
import GameFeedbackForm from '@/Components/Game/GameFeedbackForm.vue';
import LapAnalysis from '@/Pages/Game/LapAnalysis.vue';
import { lookFor } from '@/game/circuits.js';
import { isMobileDevice } from '@/game/device.js';
import { createSessionTracker, sendSessionEvents, sessionDeviceContext } from '@/game/sessionTracker.js';
import { formatDelta, formatGap, formatLapTime, formatSeconds, splitDurations } from '@/game/format.js';
import { Head, usePage } from '@inertiajs/vue3';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

const props = defineProps({
    tracks: { type: Array, default: () => [] },
    // Slug на „пистата на уикенда" — там, където Ф1 кара в момента.
    weekTrack: { type: String, default: null },
    gameFeedback: { type: Object, default: () => ({ eligible: false, last_session_id: null, submitted: false }) },
});

// Опростени контури за каталога, извлечени от същите GPS точки в
// public/game-tracks/*.json. Така картите имат истинския силует на пистата,
// без да теглим 24-те големи JSON файла преди играчът да е избрал трасе.
const TRACK_OUTLINES = Object.freeze({
    monza: 'M 27.3 38.6 L 29.3 62.1 L 31 63.2 L 29.9 68.6 L 30.3 75.1 L 32.8 80.9 L 40.2 85.4 L 57.7 86.8 L 58.7 88.5 L 69.6 91.8 L 72.5 91.2 L 74.1 79.2 L 60 71.1 L 41.3 54.6 L 41.2 50.8 L 38.6 47.1 L 34.2 9.3 L 31.9 8 L 29.4 8.7 L 26.1 13.7 L 25.7 23.9 L 27.3 38.6 Z',
    spa: 'M 39.7 83.1 L 35.4 91.9 L 46.8 85.3 L 58.8 72.7 L 60.3 67.5 L 67.4 55.1 L 75.9 25 L 73.5 21.9 L 74 15.7 L 63.1 8.1 L 61.1 8.6 L 60.6 10.7 L 66.1 14.7 L 66.6 16.3 L 62.3 34.8 L 59.5 37.4 L 55.4 37.6 L 52.4 36.2 L 45.4 21.2 L 43.1 20.3 L 37.6 21.4 L 31.6 13.2 L 29.3 13.4 L 24.3 18.1 L 24.3 20.6 L 27.4 26.7 L 32.6 31.8 L 43.3 38.1 L 48.5 48 L 44.2 64.5 L 43.8 70.5 L 46.3 71.7 L 39.7 83.1 Z',
    silverstone: 'M 54.8 91.2 L 65.3 91.9 L 68.9 89.2 L 71.2 80.5 L 72.1 66.9 L 74.3 62.1 L 72.5 54.2 L 75.1 48.2 L 74 46 L 68.7 42.1 L 50.7 10.2 L 46.8 8 L 43.7 9.4 L 40.3 15.4 L 32.5 24.4 L 29.4 22.8 L 28 23.3 L 24.9 29.6 L 40.6 50.2 L 51.8 50.2 L 61.4 57.1 L 64.4 51.3 L 66.4 51.9 L 67.9 56.4 L 67.6 60.2 L 44.5 81.4 L 42.2 82.3 L 39.8 81.6 L 38.6 76.2 L 37.3 75 L 35 75.1 L 33.7 76.7 L 37 84.9 L 41 88.9 L 54.8 91.2 Z',
    monaco: 'M 30.7 53.8 L 44.1 56.9 L 51.4 60.1 L 61.7 62.7 L 64.5 67.6 L 63.2 71.9 L 59.7 75.6 L 60.8 79.1 L 70.3 91.8 L 72.7 91 L 73.3 87.7 L 76.4 83.3 L 77.5 84.3 L 74.5 88.1 L 74.6 89.7 L 79.7 91.7 L 81.6 91.3 L 81.3 83.1 L 79.3 74 L 76.5 68.8 L 71.4 63.2 L 59.4 57.2 L 48 54.7 L 47 52.6 L 42 52.8 L 24.9 49.7 L 22.8 44.7 L 22.4 38.5 L 25.2 34.8 L 27 25 L 25.2 21.8 L 28 15.5 L 33.6 11.1 L 33.8 9.2 L 29.2 8 L 26.7 8.8 L 21.7 19.2 L 18.3 36.5 L 19.9 51.8 L 30.7 53.8 Z',
    suzuka: 'M 79.7 48.5 L 91.7 33.7 L 91.1 28.8 L 88.2 27.7 L 82.4 35.3 L 77.1 36.7 L 74.6 42.6 L 67.8 44.8 L 67 47.3 L 68.4 52.4 L 66.3 55.1 L 62.6 56.6 L 59.1 56.5 L 55.2 54.3 L 49.9 48.1 L 43.3 47.5 L 40.3 60.5 L 41.6 66.7 L 40.4 66.6 L 35 59.2 L 29 58.1 L 20.1 62.1 L 14.4 72 L 10.4 72.1 L 8.1 70.2 L 8.8 67.4 L 17.3 60.8 L 43.6 51 L 49.6 53 L 58.6 60.7 L 60.8 59.4 L 63.8 61.4 L 67.1 61.2 L 71.3 58.6 L 79.7 48.5 Z',
    red_bull_ring: 'M 64 29 L 42.6 23.7 L 29.2 43.8 L 21 60.7 L 8.1 75.4 L 21.8 76.4 L 44.3 72.5 L 61 71.1 L 61.6 69.1 L 59.7 66.2 L 54.2 62.2 L 49.2 61.3 L 36.2 63.2 L 32.2 61.2 L 31.6 55.6 L 36.9 46.3 L 39.6 44.3 L 43.5 44.8 L 48.2 49.6 L 54 52.1 L 84.8 52.9 L 87.3 51.9 L 89.9 47 L 91.5 38.3 L 84.7 34.7 L 64 29 Z',
    zandvoort: 'M 18.3 53.1 L 30.8 83.4 L 34.3 85.8 L 37 84.4 L 37.7 81.8 L 32.9 69.6 L 32.3 60.7 L 29.9 58.2 L 23 55.2 L 22.6 52.9 L 23.8 50.8 L 26.7 50.4 L 39.7 53.7 L 55.4 51.6 L 60.1 52.9 L 68.2 57.5 L 73.9 58.4 L 87.6 56.8 L 91.3 52.8 L 92 48.4 L 91.1 45.1 L 85 36.3 L 81.4 28.4 L 78 27.1 L 68.7 29.3 L 64.8 32.1 L 63.6 34.5 L 66.3 37.8 L 79.9 42.2 L 80.7 45.8 L 78.4 48.6 L 68.1 49.8 L 56.7 48.8 L 44.8 45.3 L 34.5 40.4 L 31.4 43.8 L 28.7 43.9 L 26.8 40.8 L 30.4 18 L 27.3 14.5 L 19 14.3 L 14 15.5 L 11.2 17.6 L 8.9 21 L 8 25 L 9 30.7 L 18.3 53.1 Z',
    interlagos: 'M 28.6 31.7 L 33.7 11.9 L 36.3 8.3 L 38.7 8.3 L 43.7 12.1 L 50.1 9.4 L 55.8 9.5 L 60 11.8 L 62.9 15.6 L 76.3 65.1 L 75.7 68.7 L 66.2 71.1 L 60.2 69.3 L 42 45.4 L 39.5 44 L 35.1 44.1 L 30.9 46.5 L 28.3 57 L 29.7 60.5 L 36.4 58 L 39.6 61.1 L 38.7 64.1 L 32.8 70.8 L 31.5 76.4 L 32.1 78.8 L 34.4 78.9 L 41.8 71.4 L 48.3 71.1 L 51.5 73.2 L 59.3 85.7 L 59.6 87.5 L 58.1 89.1 L 50 92 L 42.7 90.8 L 34 86.8 L 29.6 82.3 L 23.5 56.8 L 28.6 31.7 Z',
    bahrain: 'M 23.5 52.2 L 25.3 92 L 30.7 87.9 L 39.9 89.8 L 78.1 81.9 L 77.6 78.8 L 66.3 68.8 L 63.3 63.1 L 61.1 62 L 53.5 62 L 42.4 49.7 L 41.2 52.8 L 44.4 73.7 L 43.2 76.8 L 39 79.5 L 37.5 67.9 L 36.4 29.7 L 39.9 28.5 L 45.4 30.5 L 48.2 33.5 L 51.8 41.3 L 56.8 44.3 L 60.9 44 L 68.7 40.2 L 72.1 35.5 L 67.3 31.4 L 25.8 8.2 L 24 8.3 L 21.7 13.4 L 23.5 52.2 Z',
    jeddah: 'M 54.3 27.3 L 50.1 39.7 L 47.8 40.4 L 48.8 44.6 L 47.5 53.3 L 44.6 56.4 L 46 61.1 L 43.6 65.2 L 43.5 69.1 L 46.6 71.6 L 48.2 78.9 L 47.7 90.5 L 45.9 92 L 44 89.3 L 46.2 84.1 L 46.4 80.7 L 44.3 74.1 L 41.4 71.8 L 41 68.8 L 43.5 61.1 L 43.8 55 L 47.2 47.6 L 46.7 39.9 L 49.5 34.6 L 46.6 27.6 L 46.3 23.7 L 50.2 14 L 58.2 8.1 L 58.9 9.9 L 54.3 27.3 Z',
    albert_park: 'M 42.8 30 L 32 40.9 L 32.9 45.2 L 32.1 48.1 L 21 60.3 L 15.7 69.4 L 22.2 72 L 22.8 82.9 L 28.9 87.2 L 39.7 92 L 43.1 89.6 L 50.2 88 L 54.2 83.1 L 56 72.9 L 52.6 66.6 L 51 57.2 L 53.1 48.1 L 61.2 39.7 L 68.9 38.5 L 77.4 31.5 L 80.4 26.5 L 84.3 12.2 L 73.2 8 L 70.9 9.3 L 65.9 17.8 L 61.6 13.9 L 58.9 13.8 L 42.8 30 Z',
    shanghai: 'M 30.3 20.9 L 21.4 19.2 L 16.8 22.3 L 16 26.5 L 17.6 29.6 L 21.9 29.6 L 21.7 24.4 L 23.8 22.8 L 25.8 23.9 L 27 28.8 L 13.3 45.8 L 8 61.1 L 9.7 61.9 L 12.7 59.9 L 22.7 44.6 L 26.8 41.6 L 30.9 41.3 L 34.8 43.2 L 40.2 52.3 L 43.7 54.4 L 48.7 52.7 L 52.6 45.9 L 55.2 46.1 L 58.2 51.7 L 42.9 77.6 L 41 78.9 L 36.7 75.9 L 33.8 79.3 L 33.8 82.8 L 35 85.2 L 40.9 86.7 L 44.5 85.4 L 46.8 83.1 L 92 13.8 L 90.4 13.4 L 86.9 15.5 L 74.8 31.3 L 30.3 20.9 Z',
    miami: 'M 49.5 57.4 L 61.1 49.9 L 57.4 45.8 L 56.9 40.1 L 54 37.7 L 46.6 36.8 L 30.8 45.7 L 27.7 45.7 L 21.8 43 L 14.8 47.1 L 9.5 45.1 L 8.2 40.1 L 9.7 38.8 L 13.9 39.1 L 22.9 37.3 L 37.9 37.8 L 49.1 34 L 55 33.3 L 60.8 34.1 L 76.3 39.8 L 87.1 46.1 L 83.9 49.4 L 83.6 52 L 85.1 53.5 L 89.3 53.6 L 91 55.3 L 92 57.3 L 90.6 58.6 L 91.3 63.6 L 18.7 66.6 L 18.5 64.7 L 23.3 61.5 L 36.8 64.4 L 49.5 57.4 Z',
    imola: 'M 61.3 66.6 L 46.2 69 L 30.5 66.9 L 29.1 63.8 L 23.5 60.5 L 16.5 43 L 17.1 38.6 L 8.4 30.9 L 8.4 28.9 L 25 30.2 L 35.5 28.9 L 38.8 34.8 L 37.1 46.3 L 39.6 50.5 L 62.4 49.9 L 63.7 48.5 L 74.9 53.8 L 84.4 62.6 L 91.8 66.1 L 90.1 71.3 L 88.3 71.6 L 74.4 66.6 L 61.3 66.6 Z',
    catalunya: 'M 69.7 54.5 L 42.8 12 L 40.4 11.6 L 34.3 13.5 L 24.8 8 L 21.1 8.5 L 18.2 10.6 L 15.9 15.2 L 16.7 22.8 L 28 41.2 L 30.2 41.8 L 32.8 40.8 L 35 35.7 L 33.6 31.1 L 26.8 20.2 L 28.1 17.1 L 30 17 L 41.6 22.6 L 49 32.3 L 49.1 34.7 L 44.1 39.3 L 38.9 51.6 L 38.7 55.6 L 39.9 57.8 L 74.1 76.5 L 73.5 79.4 L 69.1 81 L 66 80.5 L 61.1 77.1 L 58 77.4 L 55.7 81.3 L 57.7 84.7 L 65.7 91.2 L 69.5 92 L 81.8 84.7 L 83.7 82.3 L 83.7 76.7 L 69.7 54.5 Z',
    villeneuve: 'M 59.2 31.2 L 61.5 20 L 60.9 11.8 L 63.6 9.5 L 62.2 8 L 57.8 9 L 49.9 15.1 L 49.9 18.5 L 43.2 26 L 42.6 35.3 L 38.9 36 L 37.2 38.8 L 36.7 54.5 L 38.9 64.1 L 42.4 66.3 L 44.6 74.8 L 45.4 83.3 L 44.4 91.9 L 45.5 91.6 L 46.1 86.9 L 52.5 70.8 L 58.5 42.3 L 57.3 40.3 L 59.2 31.2 Z',
    hungaroring: 'M 31.4 28.7 L 13.8 42.6 L 13 45.1 L 15.4 46.2 L 23.6 45 L 39.7 33.5 L 43.8 34.2 L 44.7 37.2 L 40.7 45.9 L 51.7 68.9 L 56 74.9 L 53 87 L 53.4 90 L 55.7 91.9 L 59 91.5 L 63.8 88.2 L 71.1 80.3 L 70.1 76.4 L 73 66.3 L 82.4 62.6 L 81.6 49.5 L 86.9 39.8 L 86.7 36.3 L 69.2 16.4 L 67.4 16.8 L 58.4 25.8 L 54.8 25.8 L 53.8 23.9 L 54.4 21.8 L 63.3 13.6 L 62.7 9.9 L 59.8 8.1 L 56.4 8.9 L 31.4 28.7 Z',
    baku: 'M 85.3 65 L 92 68.5 L 86.3 80.7 L 55.6 67.7 L 54.2 66.2 L 56.9 57.9 L 45.5 51.6 L 45.8 49 L 33.9 39.5 L 32.6 40.1 L 30.4 46.6 L 26.5 47.6 L 24.9 50.1 L 11.2 43.4 L 8 34.7 L 8.8 25.3 L 17.6 20.4 L 21.6 19.5 L 25.6 25.9 L 32.8 32.6 L 34.5 39 L 44.5 46.9 L 85.3 65 Z',
    marina_bay: 'M 90.2 56.5 L 92 41.8 L 88.2 36.6 L 72.8 38 L 70.5 42.3 L 42.8 44 L 32.1 52.6 L 30.5 52.6 L 28.4 48.3 L 23.8 24.6 L 22.5 22.8 L 14.1 30.8 L 13.7 35.4 L 8.2 39.4 L 8.2 41.4 L 19.4 61.2 L 21.9 62 L 30 54.8 L 36.3 65.4 L 55.9 54.9 L 80.1 53.9 L 82.1 57.1 L 78.5 70.6 L 78.8 75.3 L 80.3 77.2 L 83.7 74.6 L 88.1 73.3 L 90.2 56.5 Z',
    americas: 'M 24.8 34.8 L 37.4 26 L 35.2 34.3 L 35.7 37.3 L 44.6 43.9 L 47.1 48.3 L 50.5 50.2 L 52.9 55.9 L 56.7 57.5 L 62.6 55.1 L 68.2 59.7 L 72.1 57.3 L 80.7 59.2 L 91.9 73.7 L 64.8 67 L 38.3 63.3 L 43.5 54.6 L 39.6 54.2 L 36 59.2 L 33.4 59.4 L 37.6 50 L 36.2 46.4 L 32.5 44.5 L 26.8 46 L 20.4 54 L 8.7 49.3 L 8.4 47.8 L 24.8 34.8 Z',
    rodriguez: 'M 23.3 79.1 L 89.7 69.8 L 89.4 64.8 L 92 62.9 L 91.2 58.1 L 73.4 27.9 L 76.2 23.8 L 71 19.9 L 68.9 20.5 L 71 38.7 L 66.2 42.8 L 63.4 47.3 L 53.2 49.5 L 50.4 55 L 42 59.5 L 19.6 63.1 L 17.6 73.6 L 14.8 71.5 L 8.3 73 L 9 76.7 L 12.5 79.9 L 23.3 79.1 Z',
    vegas: 'M 71 17.4 L 74.2 21.2 L 73.5 23.1 L 70.5 23.3 L 64.7 20 L 62 21.1 L 60.3 23.6 L 59.8 59.8 L 60.6 61.8 L 70.7 61.7 L 73.3 63.5 L 75.2 68.2 L 72.8 70.9 L 74.5 75.8 L 54.7 77.8 L 52.1 80.3 L 47.9 88.8 L 39.4 91.9 L 30 74.1 L 26.5 62.1 L 24.9 11 L 31.1 8.1 L 58 8.2 L 64.1 9.8 L 71 17.4 Z',
    losail: 'M 26.9 41.2 L 14.9 62.9 L 14.7 66.4 L 18.5 68.3 L 27.9 62.8 L 31.4 63.1 L 32.8 65.3 L 33.5 76.3 L 46.5 90.9 L 49.4 92 L 54.8 88 L 55.6 85.1 L 46.5 74.1 L 46.8 72 L 48.7 71.5 L 64.3 77.7 L 67.1 77 L 68.3 74.1 L 62.9 66.7 L 60.3 59.5 L 50.2 56.4 L 49 54.8 L 49.2 52.6 L 54.5 48 L 60.2 45.9 L 79.6 46.7 L 82.4 44.5 L 85.6 37.5 L 81 29 L 78.7 27.3 L 63.3 30.1 L 60.7 29.4 L 50.3 9.7 L 47 8 L 43.1 11.4 L 26.9 41.2 Z',
    yas_marina: 'M 49.5 45 L 61.5 46.6 L 62.7 48.5 L 60.1 58.4 L 53.5 61.6 L 51.1 64.8 L 52.6 76.7 L 50.8 90.6 L 49 92 L 47 89.7 L 30.3 37.2 L 33.6 36.7 L 35.7 29.8 L 38.9 25.4 L 52.8 14.4 L 65.8 8 L 68.5 8.8 L 69.7 11.4 L 69.1 13.8 L 67.1 15.4 L 55.9 16.6 L 50.3 20.1 L 48.9 26.3 L 54.3 28 L 54 33.5 L 41.7 32.7 L 38.9 34.1 L 35.7 39.9 L 35.7 42.7 L 49.5 45 Z',
});

const TRACK_CARD_THEMES = Object.freeze({
    day: { accent: '#4ade80', glow: 'rgba(34,197,94,.28)', sky: '#13271f', ground: '#08110d' },
    golden: { accent: '#fbbf24', glow: 'rgba(245,158,11,.32)', sky: '#30200f', ground: '#100b08' },
    overcast: { accent: '#7dd3fc', glow: 'rgba(56,189,248,.22)', sky: '#18252d', ground: '#0a1014' },
    dusk: { accent: '#fb7185', glow: 'rgba(244,63,94,.3)', sky: '#31152c', ground: '#110912' },
    night: { accent: '#a78bfa', glow: 'rgba(124,58,237,.38)', sky: '#111632', ground: '#060711' },
});
const TRACK_PRESET_LABELS = { day: 'Дневна', golden: 'Златен час', overcast: 'Облачно', dusk: 'Здрач', night: 'Нощна' };
const TRACK_BACKDROP_LABELS = { mountains: 'Планини', treeline: 'Парк', skyline: 'Градска', dunes: 'Пустиня', sea: 'Крайбрежна', none: 'Открита' };

const trackLook = (track) => lookFor(track.slug);
const trackCardStyle = (track) => {
    const look = trackLook(track);
    const theme = TRACK_CARD_THEMES[look.preset] ?? TRACK_CARD_THEMES.day;
    const ground = look.terrain?.kind === 'sand' ? '#181008' : theme.ground;
    return {
        '--track-accent': theme.accent,
        '--track-glow': theme.glow,
        '--track-sky': theme.sky,
        '--track-ground': ground,
    };
};
const trackPresetLabel = (track) => TRACK_PRESET_LABELS[trackLook(track).preset] ?? TRACK_PRESET_LABELS.day;
const trackBackdropLabel = (track) => TRACK_BACKDROP_LABELS[trackLook(track).backdrop?.type] ?? 'Писта';
const trackCatalogOutline = (track) => TRACK_OUTLINES[track.slug]
    ?? 'M 18 55 C 18 25 38 10 62 18 C 88 27 90 58 70 78 C 52 96 20 83 18 55 Z';

// Пистата на уикенда изплува първа в списъка.
const orderedTracks = computed(() => {
    if (!props.weekTrack) {
        return props.tracks;
    }
    const week = props.tracks.filter((t) => t.slug === props.weekTrack);
    const rest = props.tracks.filter((t) => t.slug !== props.weekTrack);
    return [...week, ...rest];
});
const featuredTrack = computed(() => orderedTracks.value[0] ?? null);

const page = usePage();
const authUser = computed(() => page.props.auth?.user ?? null);
const hasPlayed = ref(props.gameFeedback.eligible);
const feedbackSessionId = ref(props.gameFeedback.last_session_id);
// Формата се отваря сама само веднъж: докато играчът не е дал мнение (никога)
// и не я е затворил с „Не сега" в този престой. Бутонът остава винаги — може
// да остави ново мнение, но не го врънкаме на всеки изход от пистата.
const feedbackAutoOpen = ref(props.gameFeedback.eligible && !props.gameFeedback.submitted);
const feedbackVisible = ref(feedbackAutoOpen.value);
const feedbackExpanded = ref(false);
const feedbackSaved = ref(false);
const onFeedbackSubmitted = () => {
    feedbackSaved.value = true;
    feedbackVisible.value = false;
    feedbackAutoOpen.value = false;
};
const onFeedbackDismissed = () => {
    feedbackVisible.value = false;
    feedbackAutoOpen.value = false;
};
const sessionTracker = createSessionTracker({
    createSession: async (payload) => (await window.axios.post('/game/session', payload)).data,
    sendEvents: sendSessionEvents,
    onSession: (id, latest) => {
        if (latest) feedbackSessionId.value = id;
    },
});

// Посещения (вкл. гости): отваряне при mount и гост-опит при всеки старт.
// Регистрираните опити минават през телеметрията; отварянето се брои от
// клиента, защото hover prefetch-ът на менюто е неразличим на сървъра.
const recordVisit = (kind) => {
    // Директно от детектора: при mount isMobile още не е попълнен (по-късен hook).
    const payload = { kind, device: isMobileDevice() ? 'mobile' : 'desktop' };
    if (kind === 'start') {
        if (!selectedTrack.value) return;
        payload.track = selectedTrack.value.slug;
    }
    window.axios.post('/game/visit', payload).catch(() => {});
};

const beginTrackingAttempt = () => {
    if (!selectedTrack.value) return;
    if (!authUser.value) {
        recordVisit('start');
        return;
    }
    hasPlayed.value = true;
    feedbackSaved.value = false;
    feedbackSessionId.value = null;
    sessionTracker.start({
        track: selectedTrack.value.slug, device: isMobile.value ? 'mobile' : 'desktop',
        mode: rivals.value === 'race' ? 'race' : 'solo',
        context: { ...sessionDeviceContext(), controls: isMobile.value ? controlMode.value : 'keyboard', graphics: settings.value.quality, transmission: transmission.value, sim_version: game.value.simVersion },
    });
    sessionTracker.pause(game.value.paused || document.hidden);
};

const openGameFeedback = () => {
    quit();
    feedbackExpanded.value = true;
    feedbackVisible.value = true;
    nextTick(() => document.getElementById('game-feedback-area')?.scrollIntoView({ block: 'start' }));
};

let sessionHeartbeat = null;
const onSessionVisibility = () => {
    if (document.hidden) sessionTracker.pause(true, 'page_hidden');
};
const onSessionPageHide = (event) => {
    if (event.persisted) sessionTracker.pause(true, 'page_hidden');
    else sessionTracker.end('page_left', {}, true);
};
onMounted(() => {
    recordVisit('view');
    sessionHeartbeat = window.setInterval(() => sessionTracker.heartbeat(), 20_000);
    document.addEventListener('visibilitychange', onSessionVisibility);
    window.addEventListener('pagehide', onSessionPageHide);
});

const canvas = ref(null);
const gameStage = ref(null);
const game = shallowRef(null);
let returnTrackSlug = null;
let gameScrollState = null;
// Класът Game (динамичен import) — пазим го за статичните константи
// (RACE_TOTAL_LAPS), без да влачим модула в основния бъндъл.
let GameClass = null;
const selectedTrack = ref(null);
const loading = ref(false);
const loadingSlug = ref(null); // картата, върху която върти спинерът преди pre-start екрана
const loadProgress = ref(0); // 0..1 — реални байтове (болид/среда/текстури)
let gameLoadRun = 0; // отменя стар async load, без неговият finally да пипа следващия
const error = ref(null);
const transmission = ref('auto'); // 'auto' | 'manual' (ръчна: W нагоре, S надолу)
const rivals = ref('race'); // 'race' (AI съперници на пистата) | 'solo' (чиста обиколка)
const RIVAL_COUNT = 5;
// Дублира Game.RACE_TOTAL_LAPS само докато класът не е зареден (pre-start
// текстът се показва преди setOpponents да го изпрати през телеметрията).
const RACE_TOTAL_LAPS_FALLBACK = 3;
// Дублира race.js RACE_PENALTY_MS / 1000 — race.js не се внася тук, за да не
// влачи симулацията в чънка на страницата (GameRaceLeaderboardTest ги пази в синхрон).
const RACE_PENALTY_SECONDS = 5;
// Мобилно управление: четири ясни бутона по подразбиране. Накланянето остава
// опция само за волана; газта и спирачката винаги са под десния палец.
const controlMode = ref('buttons'); // 'tilt' | 'buttons'
const preStart = ref(false); // pre-start екран (избор трансмисия + управление) преди обиколката
const isMobile = ref(false); // телефон/тъч → landscape сцена + екранни педали
const mobileDriving = ref(false); // landscape ограничението важи едва след „Карай"
const mobilePortrait = ref(false);
const mobileLandscapeBlocked = computed(() =>
    isMobile.value && mobileDriving.value && mobilePortrait.value
);
let mobilePresentationRun = 0;
const tiltError = ref(false); // накланянето не е достъпно/разрешено
const lowPower = ref(false); // Game.lowPower — CSS speed vignette само там (десктопът има шейдър)
const prefersReducedMotion = ref(false);

// ── Настройки на играча: persist в localStorage ───────────────────────────
// muted/volume = null означава „още не е избирано" — тогава приемаме
// стойността, която sound.js вече пази под своя ключ от стари сесии.
const SETTINGS_KEY = 'padok-game-settings';
const DEFAULT_SETTINGS = Object.freeze({
    camera: 'chase',
    muted: null,
    volume: null,
    quality: 'auto',
    motionBlur: true,
    weather: 'dry',
    compactHud: false,
});
const settings = ref({ ...DEFAULT_SETTINGS });

const QUALITY_OPTIONS = [
    { v: 'auto', l: 'Авто' },
    { v: 'low', l: 'Ниско' },
    { v: 'medium', l: 'Средно' },
    { v: 'high', l: 'Високо' },
    { v: 'ultra', l: 'Ултра' },
];
// Пресети → Game.setQuality(). „Авто" оставя runtime governor-а да пази кадрите,
// а ръчните режими са фиксиран таван. lowPower винаги налага безопасния mobile
// лимит независимо от запазения избор. dpr е таван:
// реалната стойност е min(таван, devicePixelRatio). motionBlur е отделен
// флаг (settings.motionBlur), защото се сменя на живо без пресъздаване.
const QUALITY_PRESETS = {
    low: { adaptive: false, postFx: false, shadows: 'low', csmQuality: 'low', ao: false, particles: 0.5, dpr: 1 },
    medium: { adaptive: false, postFx: true, shadows: 'low', csmQuality: 'medium', ao: false, particles: 0.75, dpr: 1.5 },
    high: { adaptive: false, postFx: true, shadows: 'high', csmQuality: 'high', ao: false, particles: 1, dpr: 2 },
    ultra: { adaptive: false, postFx: true, shadows: 'high', csmQuality: 'ultra', ao: true, particles: 1, dpr: 2 },
};

const isValidSetting = (key, value) => {
    switch (key) {
        case 'camera':
            return value === 'chase' || value === 'onboard';
        case 'muted':
        case 'motionBlur':
        case 'compactHud':
            return typeof value === 'boolean';
        case 'volume':
            return typeof value === 'number' && value >= 0 && value <= 1;
        case 'quality':
            return QUALITY_OPTIONS.some((opt) => opt.v === value);
        case 'weather':
            return value === 'dry' || value === 'wet';
        default:
            return false;
    }
};

const loadSettings = () => {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        if (!raw) {
            return;
        }
        const parsed = JSON.parse(raw);
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (isValidSetting(key, parsed?.[key])) {
                settings.value[key] = parsed[key];
            }
        }
    } catch {
        // Private mode / блокиран storage / повреден JSON — стартираме с defaults.
    }
};

const saveSettings = () => {
    try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value));
    } catch {
        // Няма storage — настройките важат само за сесията.
    }
};

watch(settings, saveSettings, { deep: true });

/**
 * Частичният quality обект за пресета (или null за „Авто").
 *
 * @param {string} preset
 * @returns {object|null}
 */
const qualityPatchFor = (preset) => {
    const base = QUALITY_PRESETS[preset];
    if (!base) {
        return null;
    }
    return { ...base, dpr: Math.min(base.dpr, window.devicePixelRatio || 1) };
};

// Кои от новите методи на Game съществуват — HUD-ът показва контролите
// само за тях, докато интеграцията ги добави (пакетите се пишат паралелно).
const emptyGameApi = () => ({
    weather: false,
    replaySpeed: false,
    replayCamera: false,
    replaySeek: false,
    photo: false,
    clip: false,
    analysis: false,
});
const gameApi = ref(emptyGameApi());

const detectGameApi = (instance) => {
    gameApi.value = {
        weather: typeof instance.setWeather === 'function',
        replaySpeed: typeof instance.setReplaySpeed === 'function',
        replayCamera: typeof instance.setReplayCamera === 'function',
        replaySeek: typeof instance.setReplayTime === 'function' || typeof instance.seekReplay === 'function',
        photo: typeof instance.capturePhoto === 'function',
        clip: typeof instance.recordClip === 'function',
        analysis: typeof instance.getLapAnalysis === 'function',
    };
};

const applyQuality = (instance = game.value) => {
    if (!instance || typeof instance.setQuality !== 'function') {
        return;
    }
    const automatic = {
        adaptive: true,
        postFx: !instance.lowPower,
        shadows: instance.lowPower ? 'low' : 'high',
        csmQuality: instance.lowPower ? 'low' : 'auto',
        ao: false,
        particles: instance.lowPower ? 0.5 : 1,
        // 1.5 е достатъчно остро на HiDPI лаптоп, но пази 44% от пикселите и
        // VRAM спрямо DPR 2. High/Ultra остават опцията за пълния таван.
        dpr: Math.min(1.5, window.devicePixelRatio || 1),
    };
    const patch = {
        motionBlur: settings.value.motionBlur,
        ...(qualityPatchFor(settings.value.quality) ?? automatic),
    };
    // Само реално различните ключове: postFx/ao пресъздават composer-а и
    // претоплят шейдърите — не бива да го правим при всяко зареждане.
    const diff = {};
    for (const [key, value] of Object.entries(patch)) {
        if (instance.quality?.[key] !== value) {
            diff[key] = value;
        }
    }
    if (Object.keys(diff).length > 0) {
        instance.setQuality(diff);
    }
};

const applyAudio = (instance = game.value) => {
    if (!instance) {
        return;
    }
    if (settings.value.muted === null) {
        settings.value.muted = instance.sound?.muted?.() ?? false;
    } else {
        instance.setMuted?.(settings.value.muted);
    }
    if (settings.value.volume === null) {
        settings.value.volume = instance.sound?.volume?.() ?? 0.8;
    } else {
        applyVolume(instance, settings.value.volume);
    }
};

const applyVolume = (instance, value) => {
    if (typeof instance.setVolume === 'function') {
        instance.setVolume(value);
    } else {
        instance.sound?.setVolume?.(value);
    }
};

const applyCamera = (instance = game.value) => {
    instance?.setCameraMode?.(settings.value.camera);
};

const applyWeather = (instance = game.value) => {
    if (instance && gameApi.value.weather) {
        instance.setWeather(settings.value.weather);
    }
};

const setCamera = (mode) => {
    settings.value.camera = mode;
    applyCamera();
};
const toggleCamera = () => setCamera(settings.value.camera === 'onboard' ? 'chase' : 'onboard');

const toggleMuted = () => {
    settings.value.muted = !(settings.value.muted ?? false);
    game.value?.setMuted?.(settings.value.muted);
};

const setVolume = (value) => {
    settings.value.volume = Math.max(0, Math.min(1, value));
    if (game.value) {
        applyVolume(game.value, settings.value.volume);
    }
};

const toggleMotionBlur = () => {
    settings.value.motionBlur = !settings.value.motionBlur;
    applyQuality();
};

// Явен handler вместо v-model + @change: слушателят на @change се закача
// преди този на v-model и би прочел СТАРИЯ пресет.
const setQualityPreset = (preset) => {
    if (QUALITY_OPTIONS.some((opt) => opt.v === preset)) {
        settings.value.quality = preset;
        applyQuality();
    }
};

const setWeather = (value) => {
    settings.value.weather = value;
    applyWeather();
};

onMounted(() => {
    // Общият детектор с Game.js (device.js) — двете преценки не бива да се
    // разминават (мобилни контроли + десктоп рендер на iPad).
    isMobile.value = isMobileDevice();
    loadSettings();
    try {
        prefersReducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        // Без matchMedia (много стар браузър) — анимациите остават.
    }

    // Ръчните скорости са неудобни на телефон — само авто.
    if (isMobile.value) {
        transmission.value = 'auto';
    }

    // Линк-покана за дуел: /game?track=monza&rival=12 отваря пистата направо
    // срещу духа на съперника.
    const params = new URLSearchParams(window.location.search);
    const trackParam = params.get('track');
    const rivalParam = params.get('rival');
    const raceRivalParam = params.get('raceRival');
    if (trackParam) {
        const track = props.tracks.find((t) => t.slug === trackParam);
        if (track) {
            const rivalId = rivalParam && /^\d+$/.test(rivalParam) ? Number(rivalParam) : null;
            const raceRivalId = raceRivalParam && /^\d+$/.test(raceRivalParam) ? Number(raceRivalParam) : null;
            startGame(track, rivalId, raceRivalId);
        }
    }
});

const emptyTelemetry = () => ({
    speed: 0,
    rpm: 4000,
    gear: 1,
    position: 1,
    fieldSize: 1,
    raceLap: 0,
    raceTotalLaps: 0,
    racePenalties: 0,
    draft: 0,
    drs: null,
    radar: null,
    tower: null,
    ghostDelta: null,
    mapDots: [],
    lapTime: null,
    lastLap: null,
    bestLap: null,
    sector: 1,
    sectors: [null, null, null],
    lapValid: true,
    started: false,
    phase: 'formation',
    recovering: false,
    recoverCount: 0,
    gated: false,
    warnings: 0,
    maxWarnings: 3,
    cameraMode: 'chase',
});

const telemetry = ref(emptyTelemetry());

// ── Живи сплитове: лилаво/зелено/жълто в момента на пресичане ────────────
// Състоянието на всеки сектор се изчислява ВЕДНЪЖ — когато сплитът се появи —
// и се кешира: иначе същият сектор би минал в „зелено" щом влезе в сесийния
// рекорд (сравнение със самия себе си), а флашът би трептял на всеки тик.
const liveSectorStates = ref([null, null, null]);
const lastSectorStates = ref(['none', 'none', 'none']);
const lastLapState = ref('none');
const lapFlashKey = ref(0); // ре-key на таймера при завършена обиколка → флаш
// Най-добрите времена в тази сесия (ms) — за гост без личен рекорд и за
// сектори, подобрени преди сървърът да е обновил userBests.
const sessionBest = { lap: null, sectors: [null, null, null] };
let prevLastLap = null;

const minNonNull = (a, b) => {
    if (a === null || a === undefined) {
        return b ?? null;
    }
    if (b === null || b === undefined) {
        return a;
    }
    return Math.min(a, b);
};

/**
 * Цветът на сектор по F1: лилаво = под рекорда на пистата (или няма такъв),
 * зелено = ≤ личния рекорд (сървър/сесия), жълто = по-бавно от него.
 *
 * @param {number} i
 * @param {number} ms
 * @returns {'purple'|'green'|'yellow'}
 */
const liveSectorState = (i, ms) => {
    const record = bests.value.sectors_ms[i];
    if (record === null || ms < record) {
        return 'purple';
    }
    const personal = minNonNull(userBests.value.sectors_ms[i], sessionBest.sectors[i]);
    return personal === null || ms <= personal ? 'green' : 'yellow';
};

const liveLapState = (ms) => {
    const record = bests.value.lap_ms;
    if (record === null || ms < record) {
        return 'purple';
    }
    const personal = minNonNull(userBests.value.lap_ms, sessionBest.lap);
    return personal === null || ms <= personal ? 'green' : 'yellow';
};

const recordSessionSector = (i, ms) => {
    sessionBest.sectors[i] = minNonNull(sessionBest.sectors[i], ms);
};

const resetSession = () => {
    sessionBest.lap = null;
    sessionBest.sectors = [null, null, null];
    liveSectorStates.value = [null, null, null];
    lastSectorStates.value = ['none', 'none', 'none'];
    lastLapState.value = 'none';
    prevLastLap = null;
};

/**
 * Кумулативните сплитове на текущата обиколка (секунди) от телеметрията.
 * Приема и числа, и {t, colour} обекти (договорът от wave 1).
 *
 * @param {object} values
 * @returns {Array<number|null>}
 */
const liveDurations = (values) => {
    const raw = values.splits;
    if (!Array.isArray(raw)) {
        return [null, null, null];
    }
    return splitDurations(raw.map((s) => (typeof s === 'number' ? s : typeof s?.t === 'number' ? s.t : null)));
};

const syncFromTelemetry = (values) => {
    // Камера/звук от клавишите (C/M в Game.js) → бързите настройки.
    if ((values.cameraMode === 'chase' || values.cameraMode === 'onboard') && values.cameraMode !== settings.value.camera) {
        settings.value.camera = values.cameraMode;
    }
    if (typeof values.muted === 'boolean' && values.muted !== settings.value.muted) {
        settings.value.muted = values.muted;
    }

    // Завършена обиколка (и в състезание, където няма onFinish): S3 се
    // оцветява едва тук, S1/S2 пазят живия си цвят.
    if (values.lastLap !== null && values.lastLap !== undefined && values.lastLap !== prevLastLap) {
        prevLastLap = values.lastLap;
        const sectorsMs = (values.sectors ?? []).map((s) => (s === null ? null : s * 1000));
        lastSectorStates.value = sectorsMs.map((ms, i) =>
            ms === null ? 'none' : liveSectorStates.value[i] ?? liveSectorState(i, ms)
        );
        sectorsMs.forEach((ms, i) => {
            if (ms !== null) {
                recordSessionSector(i, ms);
            }
        });
        const lapMs = values.lastLap * 1000;
        lastLapState.value = liveLapState(lapMs);
        // Симулацията приема обиколката за най-добра само ако е валидна —
        // затова сесийният рекорд следва bestLap, не lastLap.
        if (values.bestLap !== null && Math.abs(values.bestLap - values.lastLap) < 1e-6) {
            sessionBest.lap = minNonNull(sessionBest.lap, lapMs);
        }
        lapFlashKey.value++;
    }

    const durations = liveDurations(values);
    const states = liveSectorStates.value;
    if (values.phase !== 'flying' || durations.every((d) => d === null)) {
        if (states.some((s) => s !== null)) {
            liveSectorStates.value = [null, null, null];
        }
        return;
    }
    for (let i = 0; i < 3; i++) {
        if (durations[i] !== null && states[i] === null) {
            const ms = durations[i] * 1000;
            const state = typeof values.splits?.[i]?.colour === 'string' ? values.splits[i].colour : liveSectorState(i, ms);
            states[i] = state;
            recordSessionSector(i, ms);
        }
    }
};

const onTelemetry = (values) => {
    if (!replaying.value && !preStart.value) sessionTracker.observe(values);
    telemetry.value = values;
    syncFromTelemetry(values);
    drawMinimap(values);
};

const liveSplitDurations = computed(() => liveDurations(telemetry.value));

// Секторните чипове: живият сплит с цвета си; преди пресичането — стойността
// от предишната обиколка, затъмнена (така на екрана винаги има три числа).
const sectorCells = computed(() =>
    [0, 1, 2].map((i) => {
        const live = liveSplitDurations.value[i];
        if (live !== null) {
            return { value: live, state: liveSectorStates.value[i] ?? 'none', live: true };
        }
        const last = telemetry.value.sectors?.[i] ?? null;
        return { value: last, state: last === null ? 'none' : lastSectorStates.value[i], live: false };
    })
);

// Трите прогрес-ленти: завършен сектор = цветът му, текущият = червен
// (тече), предстоящ = сив.
const sectorBarClass = (i) => {
    const t = telemetry.value;
    if (!t.started) {
        return 'bg-zinc-700';
    }
    const state = liveSectorStates.value[i];
    if (state) {
        return BAR_CLASS[state];
    }
    return t.sector >= i + 1 ? 'bg-[#e10600]' : 'bg-zinc-700';
};

// ── Делта-бар срещу духа: центрирана нула, ±2 s = целият полу-бар ────────
const liveDelta = computed(() => {
    const d = telemetry.value.delta ?? telemetry.value.ghostDelta;
    return typeof d === 'number' ? d : null;
});
const deltaBarStyle = computed(() => {
    const frac = Math.max(-1, Math.min(1, (liveDelta.value ?? 0) / 2));
    return frac >= 0 ? { left: '50%', width: `${frac * 50}%` } : { right: '50%', width: `${-frac * 50}%` };
});
const ghostTag = computed(() => {
    if (rivalInfo.value) {
        return rivalInfo.value.name;
    }
    const dot = telemetry.value.mapDots?.find((d) => d.t === 2 || d.t === 3);
    if (!dot) {
        return 'духът';
    }
    return dot.t === 2 ? 'рекордът' : 'личният дух';
});

// ── Педали + плъзгане + кръг на сцеплението (само реални данни) ───────────
const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const throttleLevel = computed(() => numberOrNull(telemetry.value.pedals?.throttle ?? telemetry.value.throttle));
const brakeLevel = computed(() => numberOrNull(telemetry.value.pedals?.brake ?? telemetry.value.brake));
const hasPedals = computed(() => throttleLevel.value !== null || brakeLevel.value !== null);
const slipLevel = computed(() => numberOrNull(telemetry.value.slip) ?? 0);
const slipHot = computed(() => slipLevel.value > 0.3);
// 4 g = пълният радиус на кръга (болидът в играта не минава ~3.5 g).
const G_FULL = 39.24;
const frictionDot = computed(() => {
    const ax = numberOrNull(telemetry.value.ax);
    const ay = numberOrNull(telemetry.value.ay);
    if (ax === null || ay === null) {
        return null;
    }
    const full = numberOrNull(telemetry.value.gEff) ?? G_FULL;
    const x = Math.max(-1, Math.min(1, ay / full));
    const y = Math.max(-1, Math.min(1, ax / full)); // спиране (ax < 0) → точката напред/нагоре
    return { left: `${50 + x * 42}%`, top: `${50 + y * 42}%` };
});
const frictionTone = computed(() => {
    const lockF = numberOrNull(telemetry.value.lockF) ?? 0;
    const sat = Math.max(numberOrNull(telemetry.value.satF) ?? 0, numberOrNull(telemetry.value.satR) ?? 0);
    if (lockF > 0.3) {
        return 'bg-red-500';
    }
    return sat > 0.95 ? 'bg-amber-400' : 'bg-white';
});

// 331 км/ч = CAR.maxSpeed (92 m/s) — fallback, докато Game не праща speedRatio.
const speedRatio = computed(() => {
    const ratio = numberOrNull(telemetry.value.speedRatio);
    return ratio === null ? Math.min(1, (telemetry.value.speed ?? 0) / 331) : Math.max(0, Math.min(1, ratio));
});

// ── Кула на състезанието: интервали в секунди, ▲/▼ при смяна на място ────
const towerGap = (row, idx) => {
    if (idx === 0) {
        return 'Лидер';
    }
    if (row.lapped > 0) {
        return `+${row.lapped} обик.`;
    }
    // Точките за хронометраж (race.js) са през 20 m — десетите са честната точност.
    return typeof row.gapS === 'number' ? `+${row.gapS.toFixed(1)}` : '';
};
const towerArrow = (row) => (row.delta > 0 ? '▲' : row.delta < 0 ? '▼' : '');

const raceTotalLaps = computed(
    () => telemetry.value.raceTotalLaps || GameClass?.RACE_TOTAL_LAPS || RACE_TOTAL_LAPS_FALLBACK
);

// ── Мини-картата: пътят по сектори, S/F тик, точка с посока ──────────────
const minimapCanvas = ref(null);
// Backing резолюция 256 px за 128/72 CSS px — иначе линията е размазана на DPR 2.
const MINIMAP_PX = 256;
const minimapCss = computed(() => (isMobile.value ? 72 : 128));
// Играч / бот / официален дух (златист) / личен дух (син) / дуелен (фуксия) —
// типът идва от Game (mapDots.t) и следва цвета на 3D духа.
const DOT_COLORS = ['#e10600', '#9aa3ad', '#f2c14e', '#9fc8ff', '#e879f9'];
const SECTOR_STROKE = {
    purple: '#e879f9',
    green: '#34d399',
    yellow: '#fbbf24',
    none: 'rgba(255,255,255,0.55)',
};

const drawMinimapPath = () => {
    drawMinimap(telemetry.value);
};

const drawMinimap = (values) => {
    const canvas = minimapCanvas.value;
    const minimap = game.value?.minimap;
    const path = minimap?.path;
    if (!canvas || !path || path.length < 2) {
        return;
    }

    const ctx = canvas.getContext('2d');
    const s = MINIMAP_PX;
    const pad = 18;
    const scale = s - pad * 2;
    const px = (x) => pad + x * scale;
    const py = (y) => pad + y * scale;
    ctx.clearRect(0, 0, s, s);

    // Секторите като трети по прогрес (както sim.js) — освен ако Game не
    // подаде точни граници (minimap.sectorBreaks = [f1, f2], 0..1).
    const count = path.length;
    const breaks = Array.isArray(minimap.sectorBreaks) && minimap.sectorBreaks.length >= 2
        ? minimap.sectorBreaks
        : [1 / 3, 2 / 3];
    const bounds = [0, Math.floor(breaks[0] * count), Math.floor(breaks[1] * count), count];

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 5;
    for (let sec = 0; sec < 3; sec++) {
        const state = liveSectorStates.value[sec];
        const running = values.started && !state && values.sector === sec + 1;
        ctx.strokeStyle = state ? SECTOR_STROKE[state] : running ? 'rgba(255,255,255,0.9)' : SECTOR_STROKE.none;
        ctx.beginPath();
        for (let i = bounds[sec]; i <= bounds[sec + 1]; i++) {
            const [x, y] = path[i % count];
            if (i === bounds[sec]) {
                ctx.moveTo(px(x), py(y));
            } else {
                ctx.lineTo(px(x), py(y));
            }
        }
        ctx.stroke();
    }

    // Старт/финал: къс тик, перпендикулярен на посоката на движение там.
    const dir = minimap.startDir ?? { x: path[1][0] - path[0][0], y: path[1][1] - path[0][1] };
    const len = Math.hypot(dir.x, dir.y) || 1;
    const nx = -dir.y / len;
    const ny = dir.x / len;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(px(path[0][0]) - nx * 9, py(path[0][1]) - ny * 9);
    ctx.lineTo(px(path[0][0]) + nx * 9, py(path[0][1]) + ny * 9);
    ctx.stroke();

    // Другите коли първо, играчът отгоре — с триъгълник по посоката, ако я има.
    let player = null;
    for (const dot of values.mapDots ?? []) {
        if (dot.t === 0) {
            player = dot;
            continue;
        }
        ctx.beginPath();
        ctx.arc(px(dot.x), py(dot.y), 5, 0, Math.PI * 2);
        ctx.fillStyle = DOT_COLORS[dot.t] ?? '#fff';
        ctx.fill();
    }
    if (player) {
        ctx.fillStyle = DOT_COLORS[0];
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        if (typeof player.h === 'number') {
            ctx.save();
            ctx.translate(px(player.x), py(player.y));
            ctx.rotate(player.h);
            ctx.beginPath();
            ctx.moveTo(11, 0);
            ctx.lineTo(-7, 7);
            ctx.lineTo(-7, -7);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        } else {
            ctx.beginPath();
            ctx.arc(px(player.x), py(player.y), 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }
};

// Очертанието за зареждащия екран: SVG път (0..100) от minimap.path.
const trackOutline = ref(null);
const outlineSvg = computed(() => {
    const path = trackOutline.value;
    if (!path || path.length < 2) {
        return '';
    }
    return `${path.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${(x * 100).toFixed(1)} ${(y * 100).toFixed(1)}`).join(' ')} Z`;
});

// ── Класация / резултат ───────────────────────────────────────────────────
// Лилавите рекорди на пистата (обиколка + по сектори), топ класация и резултатът
// от току-що завършената квалификационна обиколка.
const bests = ref({ lap_ms: null, sectors_ms: [null, null, null] });
const userBests = ref({ lap_ms: null, sectors_ms: [null, null, null] });
const leaderboard = ref([]);
const result = ref(null); // { lapMs, sectorsMs: [..], valid }
const resultMeta = ref(null); // отговорът на сървъра: purple_lap, purple_sectors, rank…
// Референциите В МОМЕНТА на финала: след записа userBests вече включва
// тази обиколка и делтата спрямо личния рекорд би станала нула.
const resultReference = ref({ pb: null, record: null });
const submitting = ref(false);
const submitError = ref(null);
const resultTab = ref('times'); // 'times' | 'analysis'
const analysis = shallowRef(null); // Game.getLapAnalysis() за последната обиколка
const displayedLapMs = ref(null); // count-up на времето в резултатния екран
let countUpId = 0;

const fetchLeaderboard = async (slug, loadRun) => {
    const isCurrent = () => loadRun === gameLoadRun && selectedTrack.value?.slug === slug;
    try {
        const { data } = await window.axios.get(`/game/leaderboard/${slug}`);
        if (!isCurrent()) {
            return;
        }
        bests.value = data.bests ?? { lap_ms: null, sectors_ms: [null, null, null] };
        userBests.value = data.user_bests ?? { lap_ms: null, sectors_ms: [null, null, null] };
        leaderboard.value = data.top ?? [];
    } catch {
        if (!isCurrent()) {
            return;
        }
        // Класацията е бонус — липсата ѝ не бива да чупи играта.
        bests.value = { lap_ms: null, sectors_ms: [null, null, null] };
        userBests.value = { lap_ms: null, sectors_ms: [null, null, null] };
        leaderboard.value = [];
    }
};

const stopCountUp = () => {
    if (countUpId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(countUpId);
    }
    countUpId = 0;
};

// Времето „набира" от нула за 700 ms (ease-out); при reduced motion — веднага.
const runCountUp = (targetMs) => {
    stopCountUp();
    if (prefersReducedMotion.value || typeof requestAnimationFrame !== 'function') {
        displayedLapMs.value = targetMs;
        return;
    }
    const start = performance.now();
    const DURATION = 700;
    const step = (now) => {
        const t = Math.min(1, (now - start) / DURATION);
        const eased = 1 - Math.pow(1 - t, 3);
        displayedLapMs.value = t < 1 ? Math.round(targetMs * eased) : targetMs;
        countUpId = t < 1 ? requestAnimationFrame(step) : 0;
    };
    countUpId = requestAnimationFrame(step);
};

// Финал на квалификационната обиколка → резултатен екран + (ако е валидна и има
// вход) запис в класацията.
const onFinish = (res) => {
    resultReference.value = { pb: userBests.value.lap_ms, record: bests.value.lap_ms };
    result.value = res;
    resultMeta.value = null;
    submitError.value = null;
    resultTab.value = 'times';
    runCountUp(res.lapMs);

    analysis.value = null;
    if (gameApi.value.analysis) {
        try {
            analysis.value = game.value?.getLapAnalysis() ?? null;
        } catch {
            // Анализът е бонус — без него резултатът пак се показва.
        }
    }

    // onFinish идва само от соло обиколки (състезанието завършва с подиум,
    // без запис — контактите го правят невъзпроизводимо за валидацията).
    if (res.valid && res.trace && authUser.value) {
        submitLap(res);
    }
};

const submitLap = async (res) => {
    if (!selectedTrack.value) {
        return;
    }

    // Пистата може да се смени, докато заявката лети — тогава отговорът се
    // изхвърля, вместо да пренапише класацията на НОВАТА писта.
    const submittedSlug = selectedTrack.value.slug;
    const recordedAttempt = sessionTracker.current;

    submitting.value = true;
    submitError.value = null;

    try {
        const { data } = await window.axios.post('/game/lap', {
            track: submittedSlug,
            lap_ms: res.lapMs,
            sectors: res.sectorsMs,
            // Записът на входа — сървърът преиграва обиколката и я потвърждава.
            trace: res.trace,
            sim_version: res.simVersion,
        });
        sessionTracker.record('lap_submitted', { save_status: 'pending' }, recordedAttempt);

        if (selectedTrack.value?.slug !== submittedSlug) {
            return;
        }

        resultMeta.value = data;
        bests.value = data.bests ?? bests.value; // включва и тази обиколка
        userBests.value = data.user_bests ?? userBests.value;
        leaderboard.value = data.top ?? leaderboard.value;
    } catch (e) {
        sessionTracker.record('lap_save_failed', { save_status: 'failure', error_code: e?.response?.status === 422 ? 'validation_failed' : 'request_failed' }, recordedAttempt);
        if (selectedTrack.value?.slug === submittedSlug) {
            submitError.value =
                e?.response?.data?.message ?? 'Времето не се записа. Опитай пак.';
        }
    } finally {
        submitting.value = false;
    }
};

const clearResult = () => {
    stopCountUp();
    result.value = null;
    resultMeta.value = null;
    submitError.value = null;
    analysis.value = null;
    displayedLapMs.value = null;
};

const newLap = () => {
    replaying.value = false;
    clearResult();
    game.value?.reset(true);
};

// Ново състезание от подиума: решетка + светлини отначало.
const newRace = () => {
    replaying.value = false;
    clearRaceResult();
    raceMessages.value = [];
    game.value?.reset(true);
};

// ── Споделяне: Web Share на телефон, сваляне на десктоп ──────────────────
const sharing = ref(false);
const capturing = ref(false);

/**
 * @returns {Promise<boolean>} true = минало през Web Share, false = свалено
 */
const shareBlob = async (blob, filename, type) => {
    const file = new File([blob], filename, { type });
    if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        return true;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return false;
};

const shareResult = async () => {
    if (!result.value || !selectedTrack.value || sharing.value) {
        return;
    }
    sharing.value = true;
    try {
        const challengeUrl = authUser.value
            ? challengeLink(selectedTrack.value.slug, authUser.value.id)
            : null;
        const { buildShareCard } = await import('@/game/shareCard.js');
        const blob = await buildShareCard({
            trackName: selectedTrack.value.name,
            lapMs: result.value.lapMs,
            sectorsMs: result.value.sectorsMs,
            rank: resultMeta.value?.rank ?? null,
            state: lapState.value,
            challengeUrl,
            outline: game.value?.minimap?.path ?? null,
        });

        const shared = await shareBlob(blob, 'padok-hronometar.png', 'image/png');
        // Десктоп (сваляне): линкът за дуел отива и в клипборда.
        if (!shared && challengeUrl) {
            try {
                await navigator.clipboard.writeText(challengeUrl);
            } catch {
                // Блокиран клипборд — PNG-то пак е свалено, линкът е и в него.
            }
        }
    } catch {
        // Отказан share диалог/блокиран canvas — нищо.
    } finally {
        sharing.value = false;
    }
};

// Снимка на кадъра / 12-секунден клип от реплея — само ако Game ги умее.
const takePhoto = async () => {
    if (!gameApi.value.photo || capturing.value || !game.value) {
        return;
    }
    capturing.value = true;
    try {
        const blob = await game.value.capturePhoto();
        if (blob) {
            await shareBlob(blob, 'padok-hronometar.jpg', blob.type || 'image/jpeg');
        }
    } catch {
        // Отказан share/грешка при снимката — нищо.
    } finally {
        capturing.value = false;
    }
};

const recordClip = async () => {
    if (!gameApi.value.clip || capturing.value || !game.value) {
        return;
    }
    capturing.value = true;
    try {
        const blob = await game.value.recordClip(12);
        if (blob) {
            await shareBlob(blob, 'padok-hronometar.webm', blob.type || 'video/webm');
        }
    } catch {
        // Без MediaRecorder / отказан share — нищо.
    } finally {
        capturing.value = false;
    }
};

// Дуел директно от резултатния екран: духът се зарежда в ТЕКУЩАТА игра
// (без ново зареждане на пистата) и тръгва нова обиколка.
const duelFromBoard = async (row) => {
    if (!game.value || !selectedTrack.value || !row.has_ghost) {
        return;
    }
    const instance = game.value;
    try {
        const { data } = await window.axios.get(
            `/game/ghost/${selectedTrack.value.slug}/${row.user_id}`
        );
        if (game.value === instance && instance.setRivalGhost(data)) {
            rivalInfo.value = { name: data.name, lapMs: data.lap_ms };
            newLap();
        }
    } catch {
        // Духът междувременно е изчезнал — нищо.
    }
};

// ── ТВ повторение на завършената обиколка ─────────────────────────────────
const replaying = ref(false);
const replaySpeed = ref(1);
const replayCamera = ref('tv'); // 'tv' | 'onboard' | 'chase'
const REPLAY_SPEEDS = [0.5, 1, 2];
const REPLAY_CAMERAS = [
    { v: 'tv', l: 'ТВ' },
    { v: 'chase', l: 'Чейс' },
    { v: 'onboard', l: 'Бордова' },
];
const replayProgress = computed(() => numberOrNull(telemetry.value.replayProgress));
// Секторните тикове по скръбъра: кумулативните сектори / времето на обиколката.
const replaySectorTicks = computed(() => {
    const r = result.value;
    let sectors = r?.sectorsMs;
    let lapMs = r?.lapMs;
    if (!sectors) {
        const t = telemetry.value;
        if (t.lastLap && t.sectors?.every((s) => s !== null)) {
            sectors = t.sectors.map((s) => s * 1000);
            lapMs = t.lastLap * 1000;
        }
    }
    if (!sectors || !lapMs || sectors.some((s) => s === null)) {
        return [1 / 3, 2 / 3];
    }
    return [sectors[0] / lapMs, (sectors[0] + sectors[1]) / lapMs];
});

const hasReplayControls = computed(
    () => gameApi.value.replaySpeed || gameApi.value.replayCamera || gameApi.value.replaySeek || gameApi.value.clip
);

const setReplaySpeed = (speed) => {
    replaySpeed.value = speed;
    game.value?.setReplaySpeed?.(speed);
};

const setReplayCamera = (mode) => {
    replayCamera.value = mode;
    game.value?.setReplayCamera?.(mode);
};

const seekReplay = (fraction) => {
    const instance = game.value;
    if (!instance) {
        return;
    }
    const f = Math.max(0, Math.min(1, fraction));
    if (typeof instance.setReplayTime === 'function') {
        instance.setReplayTime(f);
    } else {
        instance.seekReplay?.(f);
    }
};

// ── Стартова процедура (състезание): брой светнали лампи, null = няма ─────
const launchLights = ref(null);

// ── Финал на състезанието: {position, standings, totalMs…} от Game.onRaceFinish ─
const raceResult = ref(null);
// Записът в класацията „Състезание": отговорът на сървъра и статусът.
const raceMeta = ref(null); // { total_ms, personal_best, rank, user_best_ms, top }
const raceSubmitting = ref(false);
const raceSubmitError = ref(null);
const raceHasTrace = ref(false);
let raceSubmitRun = 0;

// Задочна битка: {name, totalMs} на съперника от класацията „Състезание".
const raceRivalInfo = ref(null);

// Радиото: последните съобщения от Game.onRaceMessage, всяко живее кратко.
const raceMessages = ref([]);
const RADIO_MESSAGE_MS = 3500;
let radioKey = 0;
const pushRaceMessage = (message) => {
    const key = ++radioKey;
    raceMessages.value = [...raceMessages.value.slice(-2), { ...message, key }];
    setTimeout(() => {
        raceMessages.value = raceMessages.value.filter((item) => item.key !== key);
    }, RADIO_MESSAGE_MS);
};

// Време в класирането на подиума: победителят с общо време, останалите с
// разлика, нефиниширалите с обиколки назад.
const classificationTime = (row) => {
    if (!row.finished) {
        return row.lapsDown > 0 ? `+${row.lapsDown} обик.` : 'на пистата';
    }
    if (row.position === 1 || row.gapMs === null) {
        return formatMs(row.totalMs);
    }
    return `+${(row.gapMs / 1000).toFixed(3)}`;
};

const submitRace = async (outcome, trace) => {
    if (!selectedTrack.value) {
        return;
    }

    // „Ново състезание"/смяна на пистата, докато заявката лети → отговорът
    // вече не принадлежи на показания подиум.
    const run = ++raceSubmitRun;
    const recordedAttempt = sessionTracker.current;

    raceSubmitting.value = true;
    raceSubmitError.value = null;

    try {
        const { data } = await window.axios.post('/game/race', {
            track: selectedTrack.value.slug,
            race_ms: outcome.raceMs,
            penalties: outcome.penalties,
            position: outcome.position,
            // Записът на входа — сървърът преиграва цялото състезание.
            trace,
            sim_version: outcome.simVersion,
            race_version: outcome.raceVersion,
        });
        sessionTracker.record('lap_submitted', { save_status: 'pending' }, recordedAttempt);

        if (run === raceSubmitRun) {
            raceMeta.value = data;
        }
    } catch (e) {
        sessionTracker.record('lap_save_failed', { save_status: 'failure', error_code: e?.response?.status === 422 ? 'validation_failed' : 'request_failed' }, recordedAttempt);
        if (run === raceSubmitRun) {
            raceSubmitError.value = e?.response?.data?.message ?? 'Времето не се записа.';
        }
    } finally {
        if (run === raceSubmitRun) {
            raceSubmitting.value = false;
        }
    }
};

const clearRaceResult = () => {
    raceSubmitRun++;
    raceResult.value = null;
    raceMeta.value = null;
    raceSubmitting.value = false;
    raceSubmitError.value = null;
    raceHasTrace.value = false;
};

// ── Дуел: духът на съперник от класацията ─────────────────────────────────
const rivalInfo = ref(null); // {name, lapMs} — показва се като чип в HUD-а

// ── Класация на pre-game екрана: разгъната писта + редовете ѝ ─────────────
const expandedBoard = ref(null); // slug на пистата с отворена класация
const boardRows = ref([]);
const boardWeekly = ref(null); // седмичната класация (само пистата на уикенда)
const boardRaceRows = ref([]); // класацията „Състезание" (общо време + наказания)
const boardTab = ref('all'); // 'week' | 'all' | 'race'
const boardLoading = ref(false);

const boardTabs = computed(() => [
    ...(boardWeekly.value !== null ? [{ v: 'week', l: 'Тази седмица' }] : []),
    { v: 'all', l: 'Сам на пистата' },
    { v: 'race', l: 'Състезание' },
]);

const displayedBoardRows = computed(() => {
    if (boardTab.value === 'race') {
        return boardRaceRows.value;
    }

    return boardTab.value === 'week' && boardWeekly.value !== null ? boardWeekly.value : boardRows.value;
});
const copiedChallenge = ref(null); // ключ на реда с копиран линк (за ✓)

const toggleBoard = async (slug) => {
    if (expandedBoard.value === slug) {
        expandedBoard.value = null;
        return;
    }
    expandedBoard.value = slug;
    boardRows.value = [];
    boardWeekly.value = null;
    boardRaceRows.value = [];
    boardLoading.value = true;
    try {
        const { data } = await window.axios.get(`/game/leaderboard/${slug}`);
        if (expandedBoard.value === slug) {
            boardRows.value = data.top ?? [];
            boardWeekly.value = data.weekly ?? null;
            boardRaceRows.value = data.race_top ?? [];
            // Пистата на уикенда отваря направо седмичното предизвикателство.
            boardTab.value = data.weekly !== null && data.weekly !== undefined ? 'week' : 'all';
        }
    } catch {
        if (expandedBoard.value === slug) {
            boardRows.value = [];
            boardRaceRows.value = [];
            // Без weekly данни табът „Тази седмица" от предишна писта би
            // показал седмично празно съобщение на писта без предизвикателство.
            boardTab.value = 'all';
        }
    } finally {
        // Закъснял отговор за ВЕЧЕ сменена писта не бива да гаси спинера
        // на текущата (и обратно) — всичко е гейтнато по slug-а.
        if (expandedBoard.value === slug) {
            boardLoading.value = false;
        }
    }
};

// Линк-покана: отваря играта директно в дуел срещу духа на потребителя.
const challengeLink = (slug, userId) =>
    `${window.location.origin}/game?track=${encodeURIComponent(slug)}&rival=${userId}`;

let copiedTimer = null;

const copyChallenge = async (slug, userId, key) => {
    try {
        await navigator.clipboard.writeText(challengeLink(slug, userId));
        copiedChallenge.value = key;
        // Един таймер: повторен клик рестартира отброяването, вместо старият
        // таймер да гаси ✓-то предсрочно.
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
            copiedChallenge.value = null;
        }, 2500);
    } catch {
        // Клипбордът е блокиран (стар браузър/без HTTPS) — показваме линка.
        window.prompt('Копирай линка за дуела:', challengeLink(slug, userId));
    }
};

const startReplay = () => {
    if (game.value?.startReplay()) {
        replaying.value = true;
        replaySpeed.value = 1;
        replayCamera.value = 'tv';
    }
};

const stopReplay = () => {
    game.value?.stopReplay();
    replaying.value = false;
};

// Лилаво = рекорд на пистата. Докато сървърът не отговори, сравняваме локално
// спрямо рекордите отпреди обиколката; после ползваме авторитетния отговор.
const lapIsPurple = computed(() => {
    if (!result.value || !result.value.valid) {
        return false;
    }
    if (resultMeta.value) {
        return resultMeta.value.purple_lap;
    }
    // Строго < като сървъра (изравняване не е нов рекорд на пистата).
    return bests.value.lap_ms === null || result.value.lapMs < bests.value.lap_ms;
});

const sectorIsPurple = (i) => {
    if (!result.value || !result.value.valid || result.value.sectorsMs[i] === null) {
        return false;
    }
    if (resultMeta.value) {
        return resultMeta.value.purple_sectors?.[i] ?? false;
    }
    const best = bests.value.sectors_ms[i];
    return best === null || result.value.sectorsMs[i] < best;
};

// Цвят на сектор/обиколка (F1): лилаво = рекорд на всички (има предимство),
// зелено = личен рекорд, жълто = по-бавно от личния рекорд.
const sectorState = (i) => {
    if (!result.value || !result.value.valid || result.value.sectorsMs[i] === null) {
        return 'none';
    }
    if (sectorIsPurple(i)) {
        return 'purple';
    }
    if (resultMeta.value) {
        return resultMeta.value.green_sectors?.[i] ? 'green' : 'yellow';
    }
    const pb = userBests.value.sectors_ms[i];
    return pb === null || result.value.sectorsMs[i] <= pb ? 'green' : 'yellow';
};

const lapState = computed(() => {
    if (!result.value || !result.value.valid) {
        return 'none';
    }
    if (lapIsPurple.value) {
        return 'purple';
    }
    if (resultMeta.value) {
        return resultMeta.value.personal_best ? 'green' : 'yellow';
    }
    const pb = userBests.value.lap_ms;
    return pb === null || result.value.lapMs <= pb ? 'green' : 'yellow';
});

const resultSectorStates = computed(() => [0, 1, 2].map(sectorState));

const CELL_CLASS = {
    purple: 'border-fuchsia-500/50 bg-fuchsia-500/10',
    green: 'border-emerald-500/50 bg-emerald-500/10',
    yellow: 'border-amber-500/40 bg-amber-500/10',
    none: 'border-zinc-700 bg-zinc-800/40',
};
const TEXT_CLASS = {
    purple: 'text-fuchsia-300',
    green: 'text-emerald-300',
    yellow: 'text-amber-300',
    none: 'text-zinc-100',
};
const LAP_TEXT_CLASS = {
    purple: 'text-fuchsia-400',
    green: 'text-emerald-400',
    yellow: 'text-amber-400',
    none: 'text-white',
};
const BAR_CLASS = {
    purple: 'bg-fuchsia-400',
    green: 'bg-emerald-400',
    yellow: 'bg-amber-400',
    none: 'bg-[#e10600]',
};
const SPLIT_BORDER_CLASS = {
    purple: 'border-fuchsia-400',
    green: 'border-emerald-400',
    yellow: 'border-amber-400',
    none: 'border-zinc-600',
};
const STATE_LABEL = {
    purple: 'рекорд на пистата',
    green: 'личен рекорд',
    yellow: 'по-бавно от личния рекорд',
    none: '',
};

const sectorCellClass = (i) => CELL_CLASS[sectorState(i)];
const sectorTextClass = (i) => TEXT_CLASS[sectorState(i)];
const lapTextClass = computed(() => LAP_TEXT_CLASS[lapState.value]);

const formatMs = (ms) => (ms === null || ms === undefined ? '—' : formatLapTime(ms / 1000));
const formatSectorMs = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(3));

const lastLapDelta = computed(() =>
    formatDelta(telemetry.value.lastLap, telemetry.value.bestLap)
);

// Делта на резултата спрямо личния рекорд и рекорда на пистата (отпреди обиколката).
const resultDeltaPb = computed(() =>
    result.value && resultReference.value.pb !== null
        ? formatDelta(result.value.lapMs / 1000, resultReference.value.pb / 1000)
        : null
);
const resultDeltaRecord = computed(() =>
    result.value && resultReference.value.record !== null
        ? formatDelta(result.value.lapMs / 1000, resultReference.value.record / 1000)
        : null
);

// Обявяване за екранни четци (sr-only live region).
const liveAnnouncement = computed(() => {
    if (result.value) {
        const label = STATE_LABEL[lapState.value];
        return `Обиколка ${formatMs(result.value.lapMs)}${label ? `, ${label}` : ''}${result.value.valid ? '' : ', невалидна'}`;
    }
    if (raceResult.value) {
        return `Финал на състезанието: позиция ${raceResult.value.position}`;
    }
    return '';
});

// ── Оборотомер + предавка ──────────────────────────────────────────────────
// Дублира drivetrain.js REDLINE нарочно: статичен import на модул, който и
// lazy Game chunk-ът ползва, сгъва страницата в споделен _Index чънк и тя
// изпада от Vite manifest-а (500 от @vite; виж manualChunks за device.js във
// vite.config.js). Ако някога drivetrain.js получи свой чънк — импортирай.
const REDLINE = 15000;
const revFraction = computed(() => Math.min(1, (telemetry.value.rpm ?? 0) / REDLINE));
const atRedline = computed(() => revFraction.value > 0.94);
const gearLabel = computed(() => (telemetry.value.gear === 0 ? 'R' : String(telemetry.value.gear ?? 1)));

// Сегменти на rev-бара с shift-lights: зелено → жълто → червено (последните мигат).
const revSegments = computed(() => {
    const total = 16;
    const filled = Math.round(revFraction.value * total);
    return Array.from({ length: total }, (_, i) => {
        let color = 'bg-emerald-500';
        if (i >= total - 3) {
            color = 'bg-red-500';
        } else if (i >= total - 7) {
            color = 'bg-amber-400';
        }
        return { on: i < filled, color };
    });
});

// Първо място в класацията на пистата (от всички потребители) → трофей.
const isFirstPlace = computed(() => resultMeta.value?.rank === 1);

// Заглавието на таймера: стартова процедура / обиколка x/y / квалификация.
const timerLabel = computed(() => {
    const t = telemetry.value;
    if (launchLights.value !== null) {
        return 'Стартова процедура';
    }
    if (t.raceTotalLaps > 0) {
        return t.raceLap === 0
            ? 'Към старта'
            : `Обиколка ${Math.min(t.raceLap, t.raceTotalLaps)}/${t.raceTotalLaps}`;
    }
    return t.started ? 'Квалификационна обиколка' : 'Загряваща обиколка';
});

/**
 * Three.js се зарежда динамично: ~600 KB, които нямат работа в основния
 * бъндъл на сайта, щом играта е една страница от двайсет.
 */
const startGame = async (track, rivalUserId = null, raceRivalUserId = null) => {
    // Клавиатура/бърз двоен тап: едно зареждане наведнъж.
    if (loading.value || selectedTrack.value) {
        return;
    }
    loading.value = true;
    loadingSlug.value = track.slug;
    const loadRun = ++gameLoadRun;
    returnTrackSlug = track.slug;
    error.value = null;
    rivalInfo.value = null;
    raceRivalInfo.value = null;
    raceMessages.value = [];

    try {
        const [{ Game }, response] = await Promise.all([
            import('@/game/Game.js'),
            fetch(`/game-tracks/${track.slug}.json`),
        ]);
        if (loadRun !== gameLoadRun) {
            return;
        }
        GameClass = Game;

        if (!response.ok) {
            throw new Error(`Данните за пистата не се заредиха (${response.status}).`);
        }

        const data = await response.json();
        if (loadRun !== gameLoadRun) {
            return;
        }

        if (gameScrollState === null) {
            gameScrollState = {
                html: document.documentElement.style.overflow,
                body: document.body.style.overflow,
                x: window.scrollX,
                y: window.scrollY,
            };
        }
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        selectedTrack.value = track;
        clearResult();
        resetSession();
        preStart.value = true; // pre-start екран (избор трансмисия + управление) преди старта

        // Лилавите рекорди се теглят фоново — трябват и за живите сплитове.
        void fetchLeaderboard(track.slug, loadRun);

        // Смяната на екрана рендерира canvas-а едва след цикъла на Vue —
        // без това `canvas.value` е още null.
        await nextTick();
        syncGameViewport();

        if (!canvas.value) {
            throw new Error('Платното не се инициализира.');
        }

        loadProgress.value = 0;
        game.value = new Game(canvas.value, data, onTelemetry, onFinish, {
            onProgress: (fraction) => {
                if (loadRun === gameLoadRun) {
                    loadProgress.value = fraction;
                }
            },
            // Пресетът/условията в конструктора спестяват пресъздаване на
            // composer-а след старта; applyQuality по-долу е no-op, ако са приложени.
            quality: qualityPatchFor(settings.value.quality),
            weather: settings.value.weather,
        });

        const instance = game.value;
        instance.onAttemptStart = beginTrackingAttempt;
        instance.onLapCompleted = (lap) => sessionTracker.lapCompleted(lap);
        instance.onPauseChange = (paused) => sessionTracker.pause(paused);
        detectGameApi(instance);
        lowPower.value = instance.lowPower === true;
        // Гръмнал кадър (Game.#fail): three не се възстановява след throw в
        // render(), а грешката се повтаря на всеки кадър — сваляме играта и
        // казваме на играча, вместо да го оставим пред полунарисувана сцена.
        instance.onFatalError = (cause) => {
            if (game.value !== instance) {
                return;
            }
            console.error('Играта спря заради повторяема грешка в кадъра.', cause);
            sessionTracker.end('error', { error_code: 'render_failed' });
            quit();
            error.value = 'Играта спря заради грешка на това устройство. Опитай отново или с друг браузър.';
        };
        trackOutline.value = instance.minimap?.path ?? null;
        applyQuality(instance);
        applyWeather(instance);
        // Мобилният контейнер е fixed inset-0 — платното трябва да се
        // премери спрямо него, не спрямо първоначалния layout.
        nextTick(() => {
            if (game.value === instance) {
                instance.resize();
            }
        });

        // Реплеят може да свърши и отвътре (R рестарт) — сваляме си флага.
        instance.onReplayEnd = () => {
            replaying.value = false;
        };

        // Светлините на стартовата процедура (само в състезание).
        instance.onLaunch = (lights) => {
            launchLights.value = lights;
        };

        // Карираният флаг на състезанието → подиумът.
        instance.onRaceFinish = (raceOutcome) => {
            if (!raceOutcome) {
                clearRaceResult();
                return;
            }

            clearRaceResult();
            // Трейсът (стотици KB) не влиза в реактивното състояние.
            const { trace, ...shown } = raceOutcome;
            raceResult.value = shown;
            raceHasTrace.value = trace !== null;
            sessionTracker.end('race_completed', { race_position: raceOutcome.position, progress: 1 });

            if (trace !== null && authUser.value) {
                submitRace(raceOutcome, trace);
            }
        };

        // Полето доизкара след флага → окончателното класиране на подиума.
        instance.onRaceClassification = (final) => {
            if (!raceResult.value) {
                return;
            }
            raceResult.value = { ...raceResult.value, ...final, final: true };
        };

        instance.onRaceMessage = pushRaceMessage;

        // Вътрешен reset (R / „Рестарт" по време на реплей) сваля и соло
        // резултатния екран — иначе новата обиколка кара зад стария overlay.
        instance.onResultClear = clearResult;

        // Дуел от класацията: духът на съперника се тегли паралелно със
        // зареждането на средата. Дуелът е соло дисциплина (духът се крие в
        // състезание) — селекторът застава на „Сам на пистата", а опцията
        // „Състезание" е деактивирана, докато дуелът е активен.
        if (rivalUserId !== null) {
            rivals.value = 'solo';
            window.axios
                .get(`/game/ghost/${track.slug}/${rivalUserId}`)
                .then(({ data: ghost }) => {
                    if (game.value === instance && instance.setRivalGhost(ghost)) {
                        rivalInfo.value = { name: ghost.name, lapMs: ghost.lap_ms };
                    }
                })
                .catch(() => {
                    // Няма дух (изтрит/невалиден) — караш си нормална обиколка.
                });
        }

        // Задочна битка в състезание: най-доброто състезание на играч от
        // класацията кара като полупрозрачна кола (без контакт).
        if (raceRivalUserId !== null) {
            rivals.value = 'race';
            window.axios
                .get(`/game/race-ghost/${track.slug}/${raceRivalUserId}`)
                .then(({ data: ghost }) => {
                    if (game.value === instance && instance.setRaceRival?.(ghost)) {
                        raceRivalInfo.value = { name: ghost.name, totalMs: ghost.total_ms };
                    }
                })
                .catch(() => {
                    // Няма дух — караш си нормално състезание.
                });
        }

        // Изчакай средата (HDRI + болид + текстури) да се зареди. НЕ стартираме
        // тук — стартът чака бутона „Карай" от pre-start екрана (beginLap), след
        // като играчът избере трансмисия. Ако играчът напусне през това време
        // (game.value става null/друга инстанция), не пипаме мъртвата инстанция.
        // Loader-ите никога не reject-ват — reject тук значи гръмнал шейдър в
        // warm-up-а (renderer.compile), който би гръмнал и на всеки кадър.
        // Не го преглъщаме: catch-ът по-долу показва съобщение и сваля играта.
        try {
            await instance.ready;
        } catch (cause) {
            console.error('Warm-up на графиката се провали.', cause);
            throw new Error('Графиката на играта не се инициализира на това устройство. Опитай с друг браузър.', { cause });
        }
        if (game.value !== instance) {
            return;
        }
        window.addEventListener('resize', handleResize);
        applyAudio(instance);

        // Духът кара демо зад pre-start екрана, докато избираш настройки.
        instance.startAttract();
        drawMinimapPath();
    } catch (e) {
        if (loadRun !== gameLoadRun) {
            return;
        }
        error.value = e.message ?? 'Нещо се обърка при зареждането.';
        teardown();
        preStart.value = false;
        selectedTrack.value = null;
        // Нека dialog watcher-ът първо възстанови inert/aria-hidden. След това
        // връщаме page scroll-а, който е бил заключен преди pre-start екрана.
        await nextTick();
        setLayoutInert(false);
        releaseGameScroll();
    } finally {
        if (loadRun === gameLoadRun) {
            loading.value = false;
            loadingSlug.value = null;
        }
    }
};

// Fullscreen помага на Android да приеме orientation lock. Първият lock се
// заявява директно от тапа; ако браузърът първо иска fullscreen, повтаряме след
// него. iOS Safari обичайно отказва lock — portrait екранът долу остава fallback.
const requestMobileLandscape = (instance) => {
    const presentationRun = ++mobilePresentationRun;
    const stillActive = () =>
        mobileDriving.value && game.value === instance && presentationRun === mobilePresentationRun;
    // Fullscreen върху КОРЕНА, не върху контейнера на играта. Резултатът и
    // подиумът са <Teleport to="body"> (модален pattern с inert фон); елемент
    // във fullscreen седи в top layer с непрозрачен ::backdrop и нищо извън
    // него не се рисува — на Android диалогът след финала оставаше невидим,
    // а страницата inert, т.е. играчът зависваше до системния „Назад".
    // Коренът съдържа всичко, а контейнерът е fixed inset-0 и без това
    // покрива екрана.
    const container = document.documentElement;
    let fullscreenRequest = null;

    try {
        if (!document.fullscreenElement && typeof container?.requestFullscreen === 'function') {
            fullscreenRequest = container.requestFullscreen().catch(() => null);
            fullscreenRequest.then(() => {
                if (!stillActive()) {
                    document.exitFullscreen?.().catch(() => {});
                }
            });
        }
    } catch {
        // Fullscreen не се поддържа или е забранен — orientation overlay поема.
    }

    const lock = () => {
        try {
            return screen.orientation?.lock?.('landscape');
        } catch {
            return null;
        }
    };
    const lockRequest = lock();
    if (lockRequest && typeof lockRequest.then === 'function') {
        lockRequest.then(() => {
            if (!stillActive()) {
                screen.orientation?.unlock?.();
            }
        }).catch(() => {
            fullscreenRequest?.then(() => {
                if (stillActive()) {
                    lock()?.catch?.(() => {});
                }
            });
        });
    }
};

const leaveMobilePresentation = () => {
    mobilePresentationRun += 1;
    mobileDriving.value = false;
    mobileOrientationPaused = false;
    releaseAllTouchControls();
    try {
        document.exitFullscreen?.().catch(() => {});
        screen.orientation?.unlock?.();
    } catch {
        // Не сме във fullscreen / без Screen Orientation API.
    }
};

// Пуска обиколката от pre-start екрана: прилага избраната трансмисия и стартира.
const beginLap = () => {
    const instance = game.value;
    if (!instance) {
        return;
    }
    instance.setTransmission(transmission.value);
    // Съперниците не пипат физиката/хронометъра на играча — чист time trial
    // с трафик. Виж Game.setOpponents за „защо без колизии".
    instance.setOpponents(rivals.value === 'race' ? RIVAL_COUNT : 0);

    // Телефон: явни газ/спирачка + завиване с бутони или накланяне. Разрешението
    // за жироскоп и landscape заявката се искат ТУК, защото „Карай" е жест.
    if (isMobile.value) {
        instance.autoThrottle = false;
        mobileDriving.value = true;
        mobilePortrait.value = isPortraitViewport();
        if (controlMode.value === 'tilt') {
            enableTilt();
        }
        requestMobileLandscape(instance);
    }

    preStart.value = false;
    instance.start();
    syncMobileOrientation();
    // Камера/звук са no-op по време на attract реплея — прилагат се чак
    // след start(), който го спира.
    applyCamera(instance);
    applyAudio(instance);
    nextTick(() => {
        if (game.value === instance) {
            instance.resize();
        }
    });
};

const quit = () => {
    sessionTracker.end('quit');
    if (hasPlayed.value && feedbackAutoOpen.value && !feedbackSaved.value) feedbackVisible.value = true;
    // Освобождава каталога веднага и обезсилва стария async finally. Така
    // играчът може да избере друга писта, докато предишните ресурси приключват.
    gameLoadRun += 1;
    loading.value = false;
    loadingSlug.value = null;
    loadProgress.value = 0;
    teardown();
    selectedTrack.value = null;
    preStart.value = false;
    replaying.value = false;
    launchLights.value = null;
    clearRaceResult();
    rivalInfo.value = null;
    raceRivalInfo.value = null;
    raceMessages.value = [];
    lowPower.value = false;
    gameApi.value = emptyGameApi();
    trackOutline.value = null;
    // Панелът с класацията може да е остарял след изкараните обиколки.
    expandedBoard.value = null;
    boardRows.value = [];
    telemetry.value = emptyTelemetry();
    clearResult();
    resetSession();
    leaderboard.value = [];
    nextTick(releaseGameScroll);
};

const releaseGameScroll = () => {
    if (gameScrollState === null) {
        return;
    }
    document.documentElement.style.overflow = gameScrollState.html;
    document.body.style.overflow = gameScrollState.body;
    window.scrollTo(gameScrollState.x, gameScrollState.y);
    gameScrollState = null;
};

const restart = () => game.value?.reset(true);

// PublicLayout има max-width и вертикален padding. Игровата сцена излиза от
// тях, а височината се измерва от реалния ѝ горен ръб до visual viewport-а.
// Това е устойчиво и при по-висок header, zoom и появяваща се browser toolbar.
const syncGameViewport = () => {
    const stage = gameStage.value;
    if (!stage || isMobile.value) {
        return;
    }
    window.scrollTo(0, 0);
    const top = Math.max(0, stage.getBoundingClientRect().top);
    stage.style.setProperty('--game-available-height', `${Math.max(280, window.innerHeight - top)}px`);
};

const handleResize = () => {
    syncMobileOrientation();
    syncGameViewport();
    game.value?.resize();
};

const teardown = () => {
    window.removeEventListener('resize', handleResize);
    leaveMobilePresentation();
    disableTilt();
    stopCountUp();
    game.value?.dispose();
    game.value = null;
};

// Без това всяка навигация из сайта оставя жив WebGL контекст — браузърите
// пазят шепа такива и после отказват да създават нови.
onBeforeUnmount(() => {
    sessionTracker.end('page_left', {}, true);
    window.clearInterval(sessionHeartbeat);
    document.removeEventListener('visibilitychange', onSessionVisibility);
    window.removeEventListener('pagehide', onSessionPageHide);
    gameLoadRun += 1;
    teardown();
});

// ── Достъпност на диалозите: trap, Escape, inert фон и връщане на фокуса ──
const preStartCta = ref(null);
const preStartCancel = ref(null);
const resultCta = ref(null);
const podiumCta = ref(null);
const preStartDialog = ref(null);
const resultDialog = ref(null);
const podiumDialog = ref(null);
const activeDialog = computed(() => {
    if (preStart.value) {
        return 'prestart';
    }
    if (raceResult.value && !replaying.value) {
        return 'podium';
    }
    if (result.value && !replaying.value) {
        return 'result';
    }
    return null;
});

let returnFocusElement = null;
let inertedLayoutNodes = [];
let previousPageOverflow = '';
let layoutInertActive = false;

const dialogElement = (kind = activeDialog.value) => ({
    prestart: preStartDialog.value,
    result: resultDialog.value,
    podium: podiumDialog.value,
}[kind] ?? null);

const focusableIn = (root) => {
    if (!root) {
        return [];
    }
    return [...root.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
};

const setLayoutInert = (inert) => {
    if (inert) {
        if (layoutInertActive) {
            return;
        }
        const main = gameStage.value?.closest('main');
        const layout = main?.parentElement;
        const nodes = [layout?.querySelector(':scope > header'), main, layout?.querySelector(':scope > footer')]
            .filter(Boolean);
        inertedLayoutNodes = nodes.map((node) => ({
            node,
            inert: node.inert,
            ariaHidden: node.getAttribute('aria-hidden'),
        }));
        for (const { node } of inertedLayoutNodes) {
            node.inert = true;
            node.setAttribute('aria-hidden', 'true');
        }
        previousPageOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        layoutInertActive = true;
        return;
    }

    if (!layoutInertActive) {
        return;
    }

    for (const state of inertedLayoutNodes) {
        state.node.inert = state.inert;
        if (state.ariaHidden === null) {
            state.node.removeAttribute('aria-hidden');
        } else {
            state.node.setAttribute('aria-hidden', state.ariaHidden);
        }
    }
    inertedLayoutNodes = [];
    document.documentElement.style.overflow = previousPageOverflow;
    layoutInertActive = false;
};

const focusDialog = (kind) => {
    const primary = kind === 'prestart'
        ? (loading.value ? preStartCancel.value : preStartCta.value)
        : kind === 'result'
            ? resultCta.value
            : kind === 'podium'
                ? podiumCta.value
                : null;
    (primary ?? dialogElement(kind))?.focus?.({ preventScroll: true });
};

const tryFocus = (element) => {
    if (
        !element?.isConnected
        || element === document.body
        || element === document.documentElement
        || typeof element.focus !== 'function'
    ) {
        return false;
    }
    try {
        element.focus({ preventScroll: true });
    } catch {
        return false;
    }
    return document.activeElement === element;
};

const restoreDialogFocus = async () => {
    await nextTick();
    let restored = tryFocus(returnFocusElement);
    if (!restored && !selectedTrack.value && returnTrackSlug) {
        const target = [...document.querySelectorAll('[data-track-slug]')]
            .find((element) => element.dataset.trackSlug === returnTrackSlug);
        restored = tryFocus(target);
    }
    if (!restored) {
        tryFocus(gameStage.value);
    }
    returnFocusElement = null;
};

const closeActiveDialog = () => {
    if (activeDialog.value === 'prestart') {
        quit();
    } else if (activeDialog.value === 'podium') {
        newRace();
    } else if (activeDialog.value === 'result') {
        newLap();
    }
};

const onDialogKeydown = (event) => {
    const kind = activeDialog.value;
    if (!kind) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeActiveDialog();
        return;
    }
    if (event.key !== 'Tab') {
        return;
    }

    const root = dialogElement(kind);
    const focusable = focusableIn(root);
    if (focusable.length === 0) {
        event.preventDefault();
        root?.focus?.();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!root?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
};

watch(activeDialog, async (current, previous) => {
    if (!previous && current) {
        returnFocusElement = document.activeElement;
        setLayoutInert(true);
    } else if (previous && !current) {
        setLayoutInert(false);
        await restoreDialogFocus();
        return;
    }
    if (current) {
        await nextTick();
        focusDialog(current);
    }
}, { flush: 'post' });

onMounted(() => document.addEventListener('keydown', onDialogKeydown, true));
onBeforeUnmount(() => {
    document.removeEventListener('keydown', onDialogKeydown, true);
    setLayoutInert(false);
    releaseGameScroll();
});

// ── Управление на телефон: волан + отделни газ и спирачка ─────────────────
const setInput = (values) => game.value?.setTouchInput(values);
const touchPointers = {
    left: new Set(),
    right: new Set(),
    throttle: new Set(),
    brake: new Set(),
};

// Set по контрол пази правилно мулти-тъч: пускането на единия палец не нулира
// другия. Pointer capture гарантира pointerup/cancel дори извън бутона.
const applyTouchControls = () => {
    const values = {
        throttle: touchPointers.throttle.size > 0 ? 1 : 0,
        brake: touchPointers.brake.size > 0 ? 1 : 0,
    };
    if (controlMode.value === 'buttons') {
        values.steer =
            (touchPointers.right.size > 0 ? 1 : 0) -
            (touchPointers.left.size > 0 ? 1 : 0);
    }
    setInput(values);
};

const holdTouchControl = (event, control) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
    }
    touchPointers[control].add(event.pointerId);
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch {
        // Някои embedded браузъри нямат pointer capture; cancel/leave остава.
    }
    applyTouchControls();
};

const releaseTouchControl = (event, control) => {
    touchPointers[control].delete(event.pointerId);
    if (event.type !== 'lostpointercapture') {
        try {
            if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        } catch {
            // Capture вече е освободен от браузъра.
        }
    }
    applyTouchControls();
};

const releaseAllTouchControls = () => {
    for (const pointers of Object.values(touchPointers)) {
        pointers.clear();
    }
    setInput({ steer: 0, throttle: 0, brake: 0 });
};

const selectControlMode = (mode) => {
    releaseAllTouchControls();
    disableTilt();
    tiltError.value = false;
    controlMode.value = mode === 'tilt' ? 'tilt' : 'buttons';
};

const isPortraitViewport = () => {
    try {
        return window.matchMedia('(orientation: portrait)').matches;
    } catch {
        return window.innerHeight > window.innerWidth;
    }
};

let mobileOrientationPaused = false;
const syncMobileOrientation = () => {
    const portrait = isPortraitViewport();
    mobilePortrait.value = portrait;

    const instance = game.value;
    if (!isMobile.value || !mobileDriving.value || !instance) {
        return;
    }
    if (portrait) {
        releaseAllTouchControls();
        mobileOrientationPaused = true;
        instance.pause?.();
    } else if (mobileOrientationPaused) {
        mobileOrientationPaused = false;
        if (!document.hidden) {
            instance.resume?.();
        }
    }
};

const onMobileOrientationChange = () => {
    syncMobileOrientation();
    requestAnimationFrame(() => {
        syncMobileOrientation();
        game.value?.resize();
    });
};

const onMobileVisibilityChange = () => {
    if (document.hidden) {
        releaseAllTouchControls();
        return;
    }
    // Game възстановява rAF в собствения visibility handler. След него отново
    // налагаме portrait паузата, ако телефонът още не е завъртян.
    requestAnimationFrame(syncMobileOrientation);
};

onMounted(() => {
    mobilePortrait.value = isPortraitViewport();
    if (!isMobile.value) {
        return;
    }
    window.addEventListener('orientationchange', onMobileOrientationChange);
    window.addEventListener('blur', releaseAllTouchControls);
    document.addEventListener('visibilitychange', onMobileVisibilityChange);
});

onBeforeUnmount(() => {
    window.removeEventListener('orientationchange', onMobileOrientationChange);
    window.removeEventListener('blur', releaseAllTouchControls);
    document.removeEventListener('visibilitychange', onMobileVisibilityChange);
});

// Аналогов волан от накланянето, устойчив на портрет/пейзаж. Проектираме наклона
// върху ХОРИЗОНТАЛНАТА ОС НА ЕКРАНА (не на устройството): в портрет това е gamma,
// в пейзаж — beta, автоматично според ориентацията. Калибрира се спрямо хвата на
// старта (и при завъртане), мъртва зона ±TILT_DEADZONE°, ±TILT_MAX° = пълен волан.
const TILT_MAX = 28;
const TILT_DEADZONE = 2.5;
const TILT_INVERT = false; // ако на реалния телефон завива наобратно → true
let tiltNeutral = null;
let tiltFallbackTimer = null;

const orientationAngle = () => {
    if (typeof window.screen?.orientation?.angle === 'number') {
        return window.screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
        return (((window.orientation % 360) + 360) % 360);
    }

    return 0;
};

const onTilt = (event) => {
    if (
        !mobileDriving.value || mobilePortrait.value || controlMode.value !== 'tilt' ||
        event.gamma === null || event.gamma === undefined ||
        event.beta === null || event.beta === undefined
    ) {
        return;
    }
    if (tiltFallbackTimer !== null) {
        window.clearTimeout(tiltFallbackTimer);
        tiltFallbackTimer = null;
    }
    // Наклонът на екрана = проекция на (gamma, beta) върху хоризонталната ос,
    // завъртяна с ориентацията: портрет → gamma, пейзаж → ±beta.
    const rad = (orientationAngle() * Math.PI) / 180;
    const tilt = event.gamma * Math.cos(rad) + event.beta * Math.sin(rad);

    if (tiltNeutral === null) {
        tiltNeutral = tilt; // първи прочит (или след завъртане) = неутрално
    }
    let delta = tilt - tiltNeutral;
    const sign = Math.sign(delta);
    delta = Math.max(0, Math.abs(delta) - TILT_DEADZONE) * sign;
    let steer = Math.max(-1, Math.min(1, delta / (TILT_MAX - TILT_DEADZONE)));
    if (TILT_INVERT) {
        steer = -steer;
    }
    setInput({ steer });
};

// Портрет ↔ пейзаж сменя неутралното положение → рекалибрираме.
const onOrientationChange = () => {
    tiltNeutral = null;
};

const enableTilt = async () => {
    disableTilt();
    tiltError.value = false;
    tiltNeutral = null; // рекалибрира при следващия прочит
    try {
        // iOS 13+: иска изрично разрешение при потребителски жест.
        if (
            typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function'
        ) {
            const res = await DeviceOrientationEvent.requestPermission();
            if (res !== 'granted') {
                fallBackToButtons();

                return;
            }
        }
        window.addEventListener('deviceorientation', onTilt);
        window.addEventListener('orientationchange', onOrientationChange);
        // Някои webview браузъри обявяват API, но никога не пращат измерване.
        // Не оставяме играча без волан: след кратък прозорец показваме бутоните.
        tiltFallbackTimer = window.setTimeout(() => {
            tiltFallbackTimer = null;
            if (mobileDriving.value && controlMode.value === 'tilt' && tiltNeutral === null) {
                fallBackToButtons();
            }
        }, 1800);
    } catch {
        fallBackToButtons();
    }
};

// Отказано/недостъпно накланяне НЕ бива да остави колата без волан насред
// обиколката — бутоните се включват веднага.
const fallBackToButtons = () => {
    disableTilt();
    releaseAllTouchControls();
    tiltError.value = true;
    controlMode.value = 'buttons';
};

const disableTilt = () => {
    window.removeEventListener('deviceorientation', onTilt);
    window.removeEventListener('orientationchange', onOrientationChange);
    if (tiltFallbackTimer !== null) {
        window.clearTimeout(tiltFallbackTimer);
        tiltFallbackTimer = null;
    }
    tiltNeutral = null;
};

// Рекалибрира центъра на волана към текущия хват.
const recenterTilt = () => {
    tiltNeutral = null;
};
</script>

<template>
    <PublicLayout>
        <Head title="Игра" />

        <!-- ── Избор на писта ─────────────────────────────────────────── -->
        <div v-if="!selectedTrack" class="mx-auto max-w-6xl px-4 py-8 sm:py-10">
            <GameLobbyHero
                :track="featuredTrack"
                :track-count="tracks.length"
                :outline="featuredTrack ? trackCatalogOutline(featuredTrack) : ''"
                :loading="loading"
                @drive="featuredTrack && startGame(featuredTrack)"
            />

            <section v-if="authUser && hasPlayed" id="game-feedback-area" class="mt-6 scroll-mt-6" aria-label="Обратна връзка за играта">
                <GameFeedbackForm
                    v-if="feedbackVisible && !feedbackSaved"
                    :session-id="feedbackSessionId"
                    :initial-open="feedbackExpanded"
                    @submitted="onFeedbackSubmitted"
                    @dismiss="onFeedbackDismissed"
                />
                <p v-else-if="feedbackSaved" role="status" class="rounded-xl border border-emerald-900/60 bg-emerald-950/30 p-4 text-sm text-emerald-200">Благодарим! Мнението ти за играта е записано.</p>
                <button v-else type="button" class="rounded-xl border border-zinc-700 px-4 py-3 text-sm font-semibold text-zinc-200 hover:border-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-500" @click="feedbackVisible = true; feedbackExpanded = true">{{ gameFeedback.submitted ? 'Остави ново мнение за играта' : 'Как беше карането? Остави мнение за играта' }}</button>
            </section>

            <div class="mb-5 mt-10 flex items-end justify-between gap-4">
                <div>
                    <p class="mb-1 text-[10px] font-bold uppercase tracking-[0.24em] text-red-400">Следващата ти обиколка</p>
                    <h2 class="font-display text-2xl font-bold text-zinc-100">Избери своето трасе</h2>
                </div>
                <span class="shrink-0 pb-1 font-display text-xs tabular-nums text-zinc-500">{{ String(tracks.length).padStart(2, '0') }} писти</span>
            </div>

            <div
                v-if="error"
                class="mb-6 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200"
            >
                {{ error }}
            </div>

            <div v-if="tracks.length === 0" class="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-8 text-center text-zinc-400">
                Няма генерирани писти. Пусни
                <code class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">php artisan game:generate-tracks</code>.
            </div>

            <div v-else class="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div
                    v-for="(track, trackIndex) in orderedTracks"
                    :key="track.slug"
                    class="track-card group relative isolate overflow-hidden rounded-2xl border transition duration-300"
                    :class="[
                        track.slug === weekTrack
                            ? 'border-[#e10600]/70 ring-1 ring-[#e10600]/15'
                            : 'border-white/10',
                        loading && loadingSlug !== track.slug ? 'pointer-events-none opacity-50' : '',
                        loadingSlug === track.slug ? 'pointer-events-none border-[#e10600]' : '',
                    ]"
                    :style="trackCardStyle(track)"
                >
                    <button
                        type="button"
                        :disabled="loading"
                        class="w-full text-left disabled:cursor-wait"
                        :data-track-slug="track.slug"
                        :aria-label="`Карай на ${track.name}, ${track.location}`"
                        @click="startGame(track)"
                    >
                        <div class="track-card-visual relative z-0 h-36 overflow-hidden border-b border-white/10">
                            <div class="track-card-grid absolute inset-0 opacity-25" aria-hidden="true"></div>
                            <div class="absolute inset-x-4 top-3 z-10 flex items-center justify-between gap-2">
                                <span class="font-display text-[11px] font-black tabular-nums tracking-[0.22em] text-white/35">
                                    {{ String(trackIndex + 1).padStart(2, '0') }}
                                </span>
                                <div class="flex flex-wrap justify-end gap-1.5">
                                    <span class="rounded-full border border-white/10 bg-black/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/70 backdrop-blur-sm">
                                        {{ trackPresetLabel(track) }}
                                    </span>
                                    <span class="rounded-full border border-white/10 bg-black/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/70 backdrop-blur-sm">
                                        {{ trackBackdropLabel(track) }}
                                    </span>
                                </div>
                            </div>
                            <svg viewBox="0 0 100 100" class="track-card-outline absolute bottom-1 right-3 h-32 w-32" aria-hidden="true">
                                <path :d="trackCatalogOutline(track)" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" />
                                <path :d="trackCatalogOutline(track)" fill="none" stroke="var(--track-accent)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
                            </svg>
                        </div>

                        <div class="track-card-copy relative z-10 p-5">
                            <div class="mb-1.5 flex min-w-0 items-center gap-2">
                                <div class="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
                                    {{ track.location }}
                                </div>
                                <div v-if="track.slug === weekTrack" class="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#e10600] px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white shadow-lg shadow-red-950/40">
                                    <span class="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden="true"></span>
                                    Уикендът
                                </div>
                            </div>
                            <div class="track-card-name min-h-[3rem] text-lg font-bold leading-snug text-zinc-100 transition group-hover:text-white">
                                {{ track.name }}
                            </div>
                            <div class="mt-4 flex items-end justify-between gap-3">
                                <div class="flex items-baseline gap-4">
                                    <div class="flex items-baseline gap-1.5">
                                        <span class="font-display text-2xl font-black tabular-nums" style="color: var(--track-accent)">
                                            {{ (track.length / 1000).toFixed(3) }}
                                        </span>
                                        <span class="text-[10px] font-bold uppercase tracking-wider text-zinc-500">км</span>
                                    </div>
                                    <div v-if="track.elevation > 3" class="flex items-baseline gap-1">
                                        <span class="font-display text-base font-bold tabular-nums text-zinc-300">{{ Math.round(track.elevation) }}</span>
                                        <span class="text-[10px] uppercase tracking-wider text-zinc-500">м Δ</span>
                                    </div>
                                </div>
                                <span class="track-card-arrow grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-sm text-white/70 transition" aria-hidden="true">↗</span>
                            </div>
                        </div>
                    </button>

                    <!-- Спинер върху натиснатата карта: chunk-ът + JSON-ът на
                         пистата отнемат секунди на бавна връзка, а иначе нищо
                         не показва, че кликът е приет. -->
                    <div
                        v-if="loadingSlug === track.slug"
                        class="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950/70 backdrop-blur-[2px]"
                        role="status"
                        aria-live="polite"
                    >
                        <span class="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                            <span class="spinner h-5 w-5 rounded-full border-2 border-zinc-600 border-t-[#e10600]" aria-hidden="true"></span>
                            Зареждане…
                        </span>
                    </div>

                    <!-- Класацията на пистата: разгъва се под картата, с дуели. -->
                    <button
                        type="button"
                        class="flex w-full items-center justify-between border-t border-zinc-800/70 px-5 py-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500 transition hover:text-zinc-200"
                        :aria-expanded="String(expandedBoard === track.slug)"
                        :aria-controls="`track-board-${track.slug}`"
                        @click="toggleBoard(track.slug)"
                    >
                        <span>🏆 Класация</span>
                        <span class="text-zinc-600" aria-hidden="true">{{ expandedBoard === track.slug ? '▴' : '▾' }}</span>
                    </button>

                    <div v-if="expandedBoard === track.slug" :id="`track-board-${track.slug}`" class="border-t border-zinc-800/70 px-5 py-3">
                        <!-- Сам на пистата (+ седмичното предизвикателство на
                             пистата на уикенда) и отделната класация „Състезание" -->
                        <div class="mb-2 flex flex-wrap gap-1.5">
                            <button
                                v-for="tab in boardTabs"
                                :key="tab.v"
                                type="button"
                                class="rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider transition"
                                :class="boardTab === tab.v
                                    ? 'bg-[#e10600]/20 text-[#ff5a55]'
                                    : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'"
                                :aria-pressed="String(boardTab === tab.v)"
                                @click="boardTab = tab.v"
                            >
                                {{ tab.l }}
                            </button>
                        </div>

                        <p v-if="boardTab === 'race'" class="mb-1.5 text-[11px] text-zinc-500">
                            Общо време за {{ RACE_TOTAL_LAPS_FALLBACK }} обиколки срещу {{ RIVAL_COUNT }} съперници,
                            +{{ RACE_PENALTY_SECONDS }} s за всяко излизане от пистата.
                        </p>
                        <div v-if="boardLoading" class="py-2 text-center text-xs text-zinc-500">
                            Зареждане…
                        </div>
                        <div v-else-if="displayedBoardRows.length === 0" class="py-2 text-center text-xs text-zinc-500">
                            {{
                                boardTab === 'week'
                                    ? 'Никой не е карал тази седмица — бъди първи!'
                                    : boardTab === 'race'
                                        ? 'Още няма завършени състезания — бъди първи!'
                                        : 'Още няма времена — бъди първи!'
                            }}
                        </div>
                        <ol v-else class="space-y-1.5">
                            <li
                                v-for="(row, idx) in displayedBoardRows"
                                :key="row.user_id"
                                class="flex items-center justify-between gap-2 text-sm"
                                :class="row.is_you ? 'text-fuchsia-300' : 'text-zinc-300'"
                            >
                                <span class="min-w-0 truncate">
                                    <span class="tabular-nums text-zinc-500">{{ idx + 1 }}.</span>
                                    <a
                                        :href="`/profiles/${row.user_id}`"
                                        class="transition hover:text-white hover:underline"
                                        @click.stop
                                    >{{ row.name }}</a>
                                </span>
                                <span class="flex shrink-0 items-center gap-1.5">
                                    <span class="font-display text-xs font-bold tabular-nums">{{ formatMs(row.lap_ms ?? row.total_ms) }}</span>
                                    <button
                                        v-if="boardTab === 'race' && row.has_ghost && !row.is_you"
                                        type="button"
                                        class="rounded bg-fuchsia-500/15 px-2 py-1 text-[11px] font-bold text-fuchsia-300 transition hover:bg-fuchsia-500/30"
                                        title="Състезание срещу реалното състезание на този играч"
                                        :aria-label="`Състезание срещу ${row.name}`"
                                        @click="startGame(track, null, row.user_id)"
                                    >
                                        <span aria-hidden="true">⚔️</span> Срещу
                                    </button>
                                    <button
                                        v-if="boardTab !== 'race' && row.has_ghost && !row.is_you"
                                        type="button"
                                        class="rounded bg-fuchsia-500/15 px-2 py-1 text-[11px] font-bold text-fuchsia-300 transition hover:bg-fuchsia-500/30"
                                        title="Дуел срещу духа на тази обиколка"
                                        :aria-label="`Дуел срещу ${row.name}`"
                                        @click="startGame(track, row.user_id)"
                                    >
                                        <span aria-hidden="true">👻</span> Дуел
                                    </button>
                                    <button
                                        v-if="boardTab !== 'race' && row.has_ghost"
                                        type="button"
                                        class="rounded bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-300 transition hover:bg-zinc-700"
                                        title="Копирай линк-покана към този дуел"
                                        :aria-label="copiedChallenge === `${track.slug}:${row.user_id}` ? 'Линкът е копиран' : `Копирай линк за дуел срещу ${row.name}`"
                                        @click="copyChallenge(track.slug, row.user_id, `${track.slug}:${row.user_id}`)"
                                    >
                                        <span aria-hidden="true">{{ copiedChallenge === `${track.slug}:${row.user_id}` ? '✓' : '🔗' }}</span>
                                    </button>
                                </span>
                            </li>
                        </ol>
                    </div>
                </div>
            </div>

            <p class="mt-8 text-sm text-zinc-500">
                Управление: <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">↑</kbd>
                газ, <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">↓</kbd> или
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">Space</kbd> спирачка,
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">←</kbd>
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">→</kbd> завиване
                (или <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">WASD</kbd>),
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">R</kbd> рестарт,
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">C</kbd> бордова камера,
                <kbd class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">M</kbd> звук.
                Трансмисията (авто/ръчна) избираш преди всяка обиколка.
            </p>

            <!--
                Атрибуцията не е учтивост: данните за трасетата са под ODbL и
                посочването на източника е условие за ползването им.
            -->
            <div class="mt-10 border-t border-zinc-800 pt-6 text-xs leading-relaxed text-zinc-600">
                <p>
                    Трасетата са изградени от свободни географски данни: очертания и
                    ориентири © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" class="underline hover:text-zinc-400">OpenStreetMap contributors</a>
                    (ODbL), надморска височина през
                    <a href="https://www.opentopodata.org" target="_blank" rel="noopener noreferrer" class="underline hover:text-zinc-400">OpenTopoData</a>
                    (Mapzen / Copernicus).
                </p>
                <p class="mt-2">
                    Падок не е свързан с Formula One Group, FIA или отбор. Пистите са
                    възпроизведени по географски данни, без реклами, лога и ливреи.
                </p>
            </div>
        </div>

        <!-- ── Игрови екран ───────────────────────────────────────────── -->
        <div
            v-else
            ref="gameStage"
            tabindex="-1"
            class="game-stage relative outline-none"
            :class="isMobile ? 'game-stage-mobile h-[100dvh]' : '-my-8 h-[var(--game-available-height,calc(100dvh-3.75rem))]'"
        >
            <!-- dvh: на iOS Safari 100vh включва скритата toolbar лента и
                 бутонът „Спирачка" попадаше под browser chrome-а.
                 Телефон: fixed над sticky хедъра (z-30) — iOS няма елементен
                 fullscreen, а 4rem хедър + min-h принуждаваха скрол в пейзаж. -->
            <div
                class="h-full w-full overflow-hidden bg-zinc-950"
                :class="isMobile ? 'fixed inset-0 z-40 h-[100dvh]' : 'relative'"
            >
                <canvas ref="canvas" class="block h-full w-full touch-none"></canvas>

                <!-- Live region за екранни четци: резултатът/финалът се обявява. -->
                <div class="sr-only" role="status" aria-live="polite">{{ liveAnnouncement }}</div>

                <!-- Скоростна винетка (CSS, само lowPower — десктопът я има в шейдъра) -->
                <div
                    v-if="lowPower && telemetry.started && !replaying"
                    class="pointer-events-none absolute inset-0"
                    :style="{ opacity: speedRatio * 0.85, background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)' }"
                    aria-hidden="true"
                ></div>

                <!-- Визьорът на каската при бордовата камера -->
                <div
                    v-if="telemetry.cameraMode === 'onboard' && telemetry.started && !replaying"
                    class="pointer-events-none absolute inset-0 visor"
                    aria-hidden="true"
                ></div>

                <!-- ── HUD (декоративен за четци — числата се обявяват на финала) ── -->
                <div class="game-hud" aria-hidden="true" :class="settings.compactHud ? 'hud-compact' : ''">
                    <!-- Тайминг -->
                    <div
                        class="hud-timing pointer-events-none absolute"
                        :class="isMobile ? 'left-3 top-3' : 'left-4 top-4 sm:left-6 sm:top-6'"
                    >
                        <div
                            class="instrument-panel timing-panel rounded-lg border-l-2 border-[#e10600]"
                            :class="isMobile ? 'px-3 py-2' : 'px-4 py-3'"
                        >
                            <div v-if="!isMobile" class="hud-secondary mb-2 flex items-center justify-between gap-4 border-b border-white/10 pb-2">
                                <span class="max-w-40 truncate text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-200">{{ selectedTrack.location }}</span>
                                <span class="h-1.5 w-1.5 rounded-full" :class="telemetry.started ? 'bg-emerald-400' : 'bg-amber-400'"></span>
                            </div>
                            <div
                                class="text-[11px] font-semibold uppercase tracking-widest"
                                :class="telemetry.started ? 'text-zinc-400' : 'text-amber-400'"
                            >
                                {{ timerLabel }}
                            </div>
                            <div
                                :key="lapFlashKey"
                                class="lap-flash font-display font-black tabular-nums"
                                :class="[
                                    isMobile ? 'text-2xl' : 'text-3xl sm:text-4xl',
                                    telemetry.gated ? 'text-amber-400' : 'text-white',
                                ]"
                            >
                                {{ telemetry.started ? formatLapTime(telemetry.lapTime) : '--:--.---' }}
                            </div>
                            <div
                                v-if="telemetry.gated"
                                class="text-[11px] font-semibold uppercase tracking-wider text-amber-400"
                            >
                                Върни скоростта…
                            </div>

                            <!-- Делта-бар срещу духа: центрирана нула, ±2 s, зелено = пред него -->
                            <div v-if="liveDelta !== null" class="mt-1.5">
                                <div class="flex items-baseline justify-between gap-3">
                                    <span class="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                                        vs {{ ghostTag }}
                                    </span>
                                    <span
                                        class="shrink-0 font-display text-lg font-black tabular-nums"
                                        :class="liveDelta <= 0 ? 'text-emerald-400' : 'text-red-400'"
                                    >
                                        {{ formatGap(liveDelta) }}
                                    </span>
                                </div>
                                <div class="relative mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                                    <div class="absolute inset-y-0 left-1/2 w-px bg-zinc-500"></div>
                                    <div
                                        class="absolute inset-y-0 rounded-full"
                                        :class="liveDelta <= 0 ? 'bg-emerald-400' : 'bg-red-500'"
                                        :style="deltaBarStyle"
                                    ></div>
                                </div>
                            </div>

                            <div class="hud-secondary mt-2 space-y-0.5 text-xs">
                                <div class="flex justify-between gap-6">
                                    <span class="text-zinc-400">Най-добра</span>
                                    <span class="font-display font-bold tabular-nums text-emerald-400">
                                        {{ formatLapTime(telemetry.bestLap) }}
                                    </span>
                                </div>
                                <div class="flex justify-between gap-6">
                                    <span class="text-zinc-400">Последна</span>
                                    <span class="font-display font-bold tabular-nums" :class="LAP_TEXT_CLASS[lastLapState]">
                                        {{ formatLapTime(telemetry.lastLap) }}
                                        <span
                                            v-if="lastLapDelta"
                                            class="font-sans font-normal"
                                            :class="telemetry.lastLap <= telemetry.bestLap ? 'text-emerald-400' : 'text-red-400'"
                                        >
                                            {{ lastLapDelta }}
                                        </span>
                                    </span>
                                </div>
                                <div v-if="userBests.lap_ms !== null && !isMobile" class="flex justify-between gap-6">
                                    <span class="text-zinc-400">Личен рекорд</span>
                                    <span class="font-display font-bold tabular-nums text-emerald-400/80">
                                        {{ formatMs(userBests.lap_ms) }}
                                    </span>
                                </div>
                                <div v-if="bests.lap_ms !== null && !isMobile" class="flex justify-between gap-6">
                                    <span class="text-zinc-400">Рекорд на пистата</span>
                                    <span class="font-display font-bold tabular-nums text-fuchsia-400/80">
                                        {{ formatMs(bests.lap_ms) }}
                                    </span>
                                </div>
                            </div>

                            <div
                                v-if="!telemetry.started && telemetry.raceTotalLaps === 0 && launchLights === null"
                                class="mt-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400"
                            >
                                {{ isMobile ? 'Мини стартовата линия' : 'Мини старта за хронометрирана обиколка' }}
                            </div>
                            <div
                                v-else-if="!telemetry.lapValid && telemetry.fieldSize === 1"
                                class="mt-2 text-[11px] font-semibold uppercase tracking-wider text-red-400"
                            >
                                Невалидна — излизане от пистата
                            </div>
                            <!-- Състезание: излизанията не анулират, а добавят време -->
                            <div
                                v-else-if="telemetry.raceTotalLaps > 0"
                                class="mt-2 text-[11px] font-semibold uppercase tracking-wider"
                                :class="telemetry.racePenalties > 0 ? 'text-red-400' : 'text-zinc-500'"
                            >
                                <template v-if="telemetry.racePenalties > 0">
                                    Наказание +{{ telemetry.racePenalties * RACE_PENALTY_SECONDS }} s
                                    <span class="text-zinc-500">({{ telemetry.racePenalties }} × излизане)</span>
                                </template>
                                <template v-else>Без наказания</template>
                            </div>
                            <div v-else class="mt-2 flex items-center gap-1.5">
                                <span class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Излизания</span>
                                <span
                                    v-for="w in telemetry.maxWarnings"
                                    :key="w"
                                    class="h-2 w-2 rounded-full"
                                    :class="telemetry.warnings >= w ? 'bg-red-500' : 'bg-zinc-600'"
                                ></span>
                            </div>
                        </div>

                        <!-- Прогрес по сектори в цвета на сплита -->
                        <div class="mt-2 flex gap-1">
                            <div
                                v-for="s in 3"
                                :key="s"
                                class="h-1 w-8 rounded-full transition-colors duration-300"
                                :class="sectorBarClass(s - 1)"
                            ></div>
                        </div>

                        <!-- Живи сплитове: лилаво/зелено/жълто при пресичане; преди
                             това — времето от предишната обиколка, затъмнено. -->
                        <div class="mt-1.5 flex flex-wrap gap-1.5 font-display text-[11px] font-bold tabular-nums">
                            <span
                                v-for="(cell, i) in sectorCells"
                                :key="`${i}:${cell.live ? 'live' : 'last'}:${cell.value ?? '-'}`"
                                class="split-flash rounded border-l-2 bg-black/50 px-1.5 py-0.5 backdrop-blur-sm"
                                :class="[SPLIT_BORDER_CLASS[cell.state], cell.live ? '' : 'opacity-60']"
                            >
                                <span class="text-zinc-500">S{{ i + 1 }}</span>
                                <span class="ml-1" :class="TEXT_CLASS[cell.state]">{{ formatSeconds(cell.value) }}</span>
                            </span>
                        </div>

                        <!-- Дуел: срещу чий дух се кара -->
                        <div
                            v-if="rivalInfo"
                            class="hud-secondary mt-1.5 inline-flex items-center gap-1.5 rounded bg-fuchsia-500/20 px-2 py-1 text-[11px] font-semibold text-fuchsia-200 backdrop-blur-sm"
                        >
                            👻 Дуел с {{ rivalInfo.name }} · <span class="font-display tabular-nums">{{ formatMs(rivalInfo.lapMs) }}</span>
                        </div>

                        <!-- Задочна битка в състезание: срещу чие реално състезание се кара -->
                        <div
                            v-if="raceRivalInfo && telemetry.tower"
                            class="hud-secondary mt-1.5 inline-flex items-center gap-1.5 rounded bg-fuchsia-500/20 px-2 py-1 text-[11px] font-semibold text-fuchsia-200 backdrop-blur-sm"
                        >
                            ⚔️ Срещу {{ raceRivalInfo.name }} · <span class="font-display tabular-nums">{{ formatMs(raceRivalInfo.totalMs) }}</span>
                        </div>

                        <!-- Състезание: позиция + обиколка + кулата с интервалите в секунди -->
                        <div v-if="telemetry.tower" class="mt-2">
                            <div class="flex items-stretch gap-1.5">
                                <div class="flex items-baseline gap-1 rounded-lg bg-red-600 px-2.5 py-1 font-display font-black tabular-nums text-white">
                                    <span class="text-2xl leading-none">П{{ telemetry.position }}</span>
                                    <span class="text-xs text-white/70">/{{ telemetry.fieldSize }}</span>
                                </div>
                                <div class="flex items-center rounded-lg bg-black/55 px-2.5 font-display text-sm font-bold tabular-nums text-zinc-200 backdrop-blur-sm">
                                    L {{ Math.min(Math.max(telemetry.raceLap, 1), telemetry.raceTotalLaps) }}/{{ telemetry.raceTotalLaps }}
                                </div>
                                <!-- Слипстрийм: теглото зад колата отпред — сигнал „атакувай на правата" -->
                                <div
                                    v-if="telemetry.draft > 0.2"
                                    class="flex items-center rounded-lg bg-sky-500/25 px-2.5 text-[11px] font-bold uppercase tracking-wider text-sky-200 backdrop-blur-sm"
                                    role="status"
                                >
                                    Слипстрийм
                                </div>
                                <!-- DRS: рамка = наличен след точката за засичане, плътно = отворен -->
                                <div
                                    v-if="telemetry.drs"
                                    class="flex items-center rounded-lg px-2.5 font-display text-[11px] font-black uppercase tracking-wider backdrop-blur-sm"
                                    :class="telemetry.drs === 'open' ? 'bg-emerald-500 text-zinc-950' : 'border border-emerald-400/70 text-emerald-300'"
                                    role="status"
                                >
                                    DRS
                                </div>
                            </div>
                            <div class="instrument-panel race-tower hud-secondary mt-1.5 rounded-lg px-3 py-2 text-[11px] tabular-nums">
                                <div
                                    v-for="(row, idx) in telemetry.tower"
                                    :key="idx"
                                    class="flex items-baseline justify-between gap-3 py-0.5"
                                    :class="row.isPlayer ? 'race-tower-player font-bold text-white' : row.isRival ? 'text-fuchsia-300' : 'text-zinc-300'"
                                >
                                    <span class="flex items-baseline gap-1">
                                        <span class="w-3 text-zinc-500">{{ idx + 1 }}</span>
                                        <span
                                            class="w-2 text-[11px]"
                                            :class="row.delta > 0 ? 'text-emerald-400' : 'text-red-400'"
                                        >{{ towerArrow(row) }}</span>
                                        {{ row.isPlayer ? 'Ти' : row.isRival ? `👻 ${row.name}` : row.name }}
                                    </span>
                                    <span class="font-display" :class="idx === 0 ? 'text-zinc-500' : 'text-zinc-400'">{{ towerGap(row, idx) }}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Радио от състезанието: наказания, атаки, DRS, смени на позиция -->
                    <div
                        v-if="raceMessages.length"
                        class="pointer-events-none absolute inset-x-0 top-16 z-20 flex flex-col items-center gap-1.5 px-4"
                        role="status"
                        aria-live="polite"
                    >
                        <div
                            v-for="message in raceMessages"
                            :key="message.key"
                            class="max-w-md rounded-lg border-l-4 bg-black/75 px-3 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm sm:text-sm"
                            :class="message.tone === 'bad' ? 'border-red-500' : message.tone === 'good' ? 'border-emerald-400' : 'border-sky-400'"
                        >
                            <span class="mr-1.5 text-[10px] font-bold uppercase tracking-widest text-zinc-400">Радио</span>{{ message.text }}
                        </div>
                    </div>

                    <!-- Радар: кола отстрани в борба колело до колело -->
                    <template v-if="telemetry.radar">
                        <div
                            class="pointer-events-none absolute left-2 top-1/2 h-32 w-1.5 -translate-y-1/2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.8)] transition-opacity duration-150 sm:left-4"
                            :style="{ opacity: telemetry.radar.left }"
                            aria-hidden="true"
                        ></div>
                        <div
                            class="pointer-events-none absolute right-2 top-1/2 h-32 w-1.5 -translate-y-1/2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.8)] transition-opacity duration-150 sm:right-4"
                            :style="{ opacity: telemetry.radar.right }"
                            aria-hidden="true"
                        ></div>
                    </template>

                    <!-- ODbL иска източникът да се вижда там, където се вижда и картата. -->
                    <div class="pointer-events-none absolute bottom-0 left-0 hidden p-2 text-[11px] text-white/35 sm:block">
                        Трасе © OpenStreetMap contributors · височини OpenTopoData
                    </div>

                    <!-- Скорост + предавка + оборотомер + педали. Телефон: горе
                         вдясно под бутоните, за да не го покрива „Спирачка". -->
                    <div
                        class="hud-speed pointer-events-none absolute"
                        :class="isMobile ? 'right-3 top-[4.75rem]' : 'bottom-4 right-4 sm:bottom-6 sm:right-6'"
                    >
                        <div
                            class="instrument-panel speed-panel rounded-lg border-t-2 border-[#e10600]"
                            :class="isMobile ? 'px-3 py-2' : 'px-5 py-3'"
                        >
                            <div>
                                <!-- Rev бар с shift-lights (мига в червената зона) -->
                                <div class="rev-strip mb-3 flex gap-[3px]" :class="atRedline ? 'motion-safe:animate-pulse' : ''">
                                    <span
                                        v-for="(seg, i) in revSegments"
                                        :key="i"
                                        class="flex-1 rounded-[2px]"
                                        :class="[isMobile ? 'h-1.5 w-1.5' : 'h-2 w-2', seg.on ? seg.color : 'bg-zinc-700/60']"
                                    ></span>
                                </div>

                                <div class="flex items-end justify-end gap-3 sm:gap-4">
                                    <!-- Педали: газ (зелено) и спирачка (червено) — реални стойности -->
                                    <div v-if="hasPedals" class="flex items-end gap-1 self-stretch">
                                        <div class="flex w-2 flex-col justify-end overflow-hidden rounded-sm bg-zinc-800/80" :class="isMobile ? 'h-10' : 'h-14'">
                                            <div class="w-full bg-emerald-400" :style="{ height: `${(throttleLevel ?? 0) * 100}%` }"></div>
                                        </div>
                                        <div class="flex w-2 flex-col justify-end overflow-hidden rounded-sm bg-zinc-800/80" :class="isMobile ? 'h-10' : 'h-14'">
                                            <div class="w-full bg-red-500" :style="{ height: `${(brakeLevel ?? 0) * 100}%` }"></div>
                                        </div>
                                    </div>

                                    <!-- Кръг на сцеплението (само с реални ax/ay от симулацията) -->
                                    <div
                                        v-if="frictionDot && !isMobile"
                                        class="relative h-8 w-8 self-center rounded-full border border-zinc-600/80"
                                    >
                                        <div class="absolute inset-x-0 top-1/2 h-px bg-zinc-700/70"></div>
                                        <div class="absolute inset-y-0 left-1/2 w-px bg-zinc-700/70"></div>
                                        <div
                                            class="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                                            :class="frictionTone"
                                            :style="frictionDot"
                                        ></div>
                                    </div>

                                    <!-- Предавка (key-а рестартира pop анимацията при смяна) -->
                                    <div class="gear-cell text-center" :class="isMobile ? 'px-2 py-1' : 'px-3 py-2'">
                                        <div
                                            :key="gearLabel"
                                            class="gear-pop font-display font-black leading-none tabular-nums text-white"
                                            :class="isMobile ? 'text-2xl' : 'text-4xl sm:text-5xl'"
                                        >
                                            {{ gearLabel }}
                                        </div>
                                        <div class="mt-1 text-[9px] font-semibold uppercase tracking-widest text-zinc-400">
                                            предавка
                                        </div>
                                    </div>
                                    <!-- Скорост: кехлибарена при плъзгане (slip > 0.3) -->
                                    <div class="speed-readout text-right">
                                        <div
                                            class="font-display font-black leading-none tabular-nums transition-colors duration-150"
                                            :class="[isMobile ? 'text-3xl' : 'text-5xl sm:text-6xl', slipHot ? 'text-amber-300' : 'text-white']"
                                        >
                                            {{ telemetry.speed }}
                                        </div>
                                        <div class="mt-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-400">
                                            км/ч
                                        </div>
                                    </div>
                                </div>

                                <!-- Обороти -->
                                <div v-if="!isMobile" class="hud-secondary mt-3 flex items-center justify-between border-t border-white/10 pt-2 text-[10px] font-semibold tabular-nums text-zinc-400">
                                    <span class="uppercase tracking-widest">{{ transmission === 'manual' ? 'Ръчна' : 'Автоматична' }}</span>
                                    <span class="font-display">{{ (telemetry.rpm ?? 0).toLocaleString('bg-BG') }} <span class="font-sans font-normal">об/мин</span></span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Мини-карта: сектори в цвят, S/F тик, посока на колата.
                         Телефон: 72 px горе в центъра (най-полезна е точно там,
                         където tilt играчът не вижда далеч напред). -->
                    <div
                        class="hud-minimap instrument-panel pointer-events-none absolute overflow-hidden rounded-lg"
                        :class="isMobile ? 'left-1/2 top-3 -translate-x-1/2' : 'right-4 top-[7.5rem] sm:right-6'"
                    >
                        <canvas
                            ref="minimapCanvas"
                            :width="MINIMAP_PX"
                            :height="MINIMAP_PX"
                            class="block"
                            :style="{ width: `${minimapCss}px`, height: `${minimapCss}px` }"
                        ></canvas>
                        <div v-if="!isMobile" class="hud-secondary flex justify-between gap-2 border-t border-white/10 px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-zinc-400">
                            <span>Трасе</span>
                            <span class="tabular-nums text-zinc-200">{{ (selectedTrack.length / 1000).toFixed(3) }} км</span>
                        </div>
                    </div>
                </div>

                <!-- Изход / рестарт + бързи настройки -->
                <div class="game-toolbar absolute flex flex-col items-end gap-2">
                    <div class="flex gap-2">
                        <button
                            type="button"
                            class="rounded-lg bg-black/55 font-semibold uppercase tracking-wider text-zinc-300 backdrop-blur-sm transition hover:bg-black/75 hover:text-white"
                            :class="isMobile ? 'min-h-11 min-w-11 px-2 text-base' : 'px-3 py-2 text-xs'"
                            aria-label="Рестартирай обиколката"
                            @click="restart"
                        >
                            <span v-if="isMobile" aria-hidden="true">↻</span>
                            <span v-else>Рестарт</span>
                        </button>
                        <button
                            type="button"
                            class="rounded-lg bg-black/55 font-semibold uppercase tracking-wider text-zinc-300 backdrop-blur-sm transition hover:bg-black/75 hover:text-white"
                            :class="isMobile ? 'min-h-11 min-w-11 px-2 text-base' : 'px-3 py-2 text-xs'"
                            aria-label="Смени пистата"
                            @click="quit"
                        >
                            <span v-if="isMobile" aria-hidden="true">×</span>
                            <span v-else>Смени пистата</span>
                        </button>
                        <!-- Телефон: камера + звук са в горния ред (няма клавиши C/M) -->
                        <template v-if="isMobile">
                            <button
                                type="button"
                                class="min-h-11 min-w-11 rounded-lg bg-black/55 px-2 text-sm font-semibold backdrop-blur-sm transition hover:bg-black/75"
                                :class="settings.camera === 'onboard' ? 'text-white' : 'text-zinc-300'"
                                :aria-pressed="String(settings.camera === 'onboard')"
                                aria-label="Бордова камера"
                                :disabled="replaying"
                                @click="toggleCamera"
                            >
                                <span aria-hidden="true">🎥</span>
                            </button>
                            <button
                                type="button"
                                class="min-h-11 min-w-11 rounded-lg bg-black/55 px-2 text-sm font-semibold text-zinc-300 backdrop-blur-sm transition hover:bg-black/75"
                                :aria-pressed="String(settings.muted === true)"
                                :aria-label="settings.muted ? 'Пусни звука' : 'Заглуши звука'"
                                :disabled="replaying"
                                @click="toggleMuted"
                            >
                                <span aria-hidden="true">{{ settings.muted ? '🔇' : '🔊' }}</span>
                            </button>
                        </template>
                    </div>

                    <!-- Десктоп: бързи настройки (камера/звук/сила/качество/motion blur/компактен HUD) -->
                    <div
                        v-if="!isMobile"
                        class="flex flex-wrap items-center justify-end gap-1.5 rounded-lg bg-black/55 p-1.5 backdrop-blur-sm"
                        role="group"
                        aria-label="Бързи настройки"
                    >
                        <button
                            type="button"
                            class="rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition"
                            :class="settings.camera === 'onboard' ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-white'"
                            :aria-pressed="String(settings.camera === 'onboard')"
                            :disabled="replaying"
                            title="Бордова камера (C)"
                            @click="toggleCamera"
                        >
                            {{ settings.camera === 'onboard' ? 'Бордова' : 'Чейс' }}
                        </button>
                        <button
                            type="button"
                            class="rounded px-2 py-1 text-[11px] transition hover:bg-white/10"
                            :aria-pressed="String(settings.muted === true)"
                            :aria-label="settings.muted ? 'Пусни звука' : 'Заглуши звука'"
                            :disabled="replaying"
                            title="Звук (M)"
                            @click="toggleMuted"
                        >
                            <span aria-hidden="true">{{ settings.muted ? '🔇' : '🔊' }}</span>
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            class="h-1 w-16 cursor-pointer accent-[#e10600]"
                            :value="settings.volume ?? 0.8"
                            aria-label="Сила на звука"
                            @input="setVolume(Number($event.target.value))"
                        />
                        <label class="flex items-center gap-1 text-[11px] text-zinc-400">
                            <span class="sr-only">Графика</span>
                            <select
                                :value="settings.quality"
                                class="rounded border-0 bg-zinc-900/80 py-1 pl-2 pr-6 text-[11px] font-semibold text-zinc-200 focus:ring-1 focus:ring-[#e10600]"
                                aria-label="Графика"
                                @change="setQualityPreset($event.target.value)"
                            >
                                <option v-for="opt in QUALITY_OPTIONS" :key="opt.v" :value="opt.v">{{ opt.l }}</option>
                            </select>
                        </label>
                        <button
                            type="button"
                            class="rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition"
                            :class="settings.motionBlur ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-white'"
                            :aria-pressed="String(settings.motionBlur)"
                            title="Размазване при скорост"
                            @click="toggleMotionBlur"
                        >
                            Blur
                        </button>
                        <button
                            type="button"
                            class="rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition"
                            :class="settings.compactHud ? 'bg-white/15 text-white' : 'text-zinc-400 hover:text-white'"
                            :aria-pressed="String(settings.compactHud)"
                            title="Компактен HUD"
                            @click="settings.compactHud = !settings.compactHud"
                        >
                            HUD
                        </button>
                        <button
                            v-if="gameApi.photo"
                            type="button"
                            class="rounded px-2 py-1 text-[11px] transition hover:bg-white/10 disabled:opacity-50"
                            aria-label="Снимка на кадъра"
                            title="Снимка"
                            :disabled="capturing"
                            @click="takePhoto"
                        >
                            <span aria-hidden="true">📷</span>
                        </button>
                    </div>
                </div>

                <!-- Телефон: ляв палец завива, десният държи газ/спирачка.
                     Накланянето може да замести само волана. Контролите се
                     крият в ТВ реплей и portrait gate-ът стои над тях. -->
                <div
                    v-if="isMobile && mobileDriving && !mobileLandscapeBlocked && !replaying"
                    class="mobile-controls pointer-events-none absolute inset-x-0 bottom-0 z-20 select-none"
                >
                    <div class="flex items-end justify-between gap-4">
                        <!-- Накланяне: рекалибриране на центъра. -->
                        <button
                            v-if="controlMode === 'tilt'"
                            type="button"
                            class="mobile-recenter pointer-events-auto touch-none rounded-xl border border-white/15 bg-black/70 px-4 text-xs font-bold uppercase tracking-wider text-zinc-100 active:bg-black/90"
                            aria-label="Центрирай волана към текущия наклон"
                            @pointerdown.prevent="recenterTilt"
                            @contextmenu.prevent
                        >
                            <span aria-hidden="true">⌖</span> Центрирай
                        </button>
                        <!-- Бутони: ляво/дясно под левия палец. -->
                        <div v-else class="flex gap-2" role="group" aria-label="Завиване">
                            <button
                                type="button"
                                class="mobile-control-button pointer-events-auto touch-none rounded-2xl border border-white/20 bg-black/65 text-2xl font-black text-white active:border-white/50 active:bg-white/25"
                                aria-label="Завий наляво"
                                @pointerdown.prevent="holdTouchControl($event, 'left')"
                                @pointerup.prevent="releaseTouchControl($event, 'left')"
                                @pointerleave.prevent="releaseTouchControl($event, 'left')"
                                @pointercancel.prevent="releaseTouchControl($event, 'left')"
                                @lostpointercapture="releaseTouchControl($event, 'left')"
                                @dragstart.prevent
                                @contextmenu.prevent
                            >
                                <span aria-hidden="true">◀</span>
                            </button>
                            <button
                                type="button"
                                class="mobile-control-button pointer-events-auto touch-none rounded-2xl border border-white/20 bg-black/65 text-2xl font-black text-white active:border-white/50 active:bg-white/25"
                                aria-label="Завий надясно"
                                @pointerdown.prevent="holdTouchControl($event, 'right')"
                                @pointerup.prevent="releaseTouchControl($event, 'right')"
                                @pointerleave.prevent="releaseTouchControl($event, 'right')"
                                @pointercancel.prevent="releaseTouchControl($event, 'right')"
                                @lostpointercapture="releaseTouchControl($event, 'right')"
                                @dragstart.prevent
                                @contextmenu.prevent
                            >
                                <span aria-hidden="true">▶</span>
                            </button>
                        </div>
                        <div class="flex gap-2" role="group" aria-label="Педали">
                            <button
                                type="button"
                                class="mobile-pedal-button pointer-events-auto touch-none rounded-2xl border border-red-300/35 bg-red-950/75 text-sm font-black uppercase tracking-wider text-red-50 active:border-red-200 active:bg-red-700/80"
                                aria-label="Спирачка"
                                @pointerdown.prevent="holdTouchControl($event, 'brake')"
                                @pointerup.prevent="releaseTouchControl($event, 'brake')"
                                @pointerleave.prevent="releaseTouchControl($event, 'brake')"
                                @pointercancel.prevent="releaseTouchControl($event, 'brake')"
                                @lostpointercapture="releaseTouchControl($event, 'brake')"
                                @dragstart.prevent
                                @contextmenu.prevent
                            >
                                Спирачка
                            </button>
                            <button
                                type="button"
                                class="mobile-pedal-button pointer-events-auto touch-none rounded-2xl border border-emerald-300/35 bg-emerald-950/75 text-sm font-black uppercase tracking-wider text-emerald-50 active:border-emerald-200 active:bg-emerald-700/80"
                                aria-label="Газ"
                                @pointerdown.prevent="holdTouchControl($event, 'throttle')"
                                @pointerup.prevent="releaseTouchControl($event, 'throttle')"
                                @pointerleave.prevent="releaseTouchControl($event, 'throttle')"
                                @pointercancel.prevent="releaseTouchControl($event, 'throttle')"
                                @lostpointercapture="releaseTouchControl($event, 'throttle')"
                                @dragstart.prevent
                                @contextmenu.prevent
                            >
                                Газ
                            </button>
                        </div>
                    </div>
                    <p v-if="tiltError" class="mt-2 text-center text-[11px] font-semibold text-amber-400">
                        Накланянето не е достъпно — включихме екранните бутони.
                    </p>
                </div>

                <!-- Screen Orientation API не работи навсякъде (особено iOS).
                     Затова реалният размер на viewport-а остава източникът на
                     истина: portrait паузира играта и поема всички докосвания. -->
                <div
                    v-if="mobileLandscapeBlocked"
                    class="absolute inset-0 z-[70] flex items-center justify-center bg-zinc-950/95 px-8 text-center"
                    role="alert"
                    aria-labelledby="rotate-phone-title"
                >
                    <div class="max-w-sm">
                        <div class="mx-auto mb-5 flex h-20 w-12 items-center justify-center rounded-xl border-2 border-zinc-400 text-3xl text-white" aria-hidden="true">
                            ↻
                        </div>
                        <h2 id="rotate-phone-title" class="font-display text-xl font-black uppercase tracking-wider text-white">
                            Завърти телефона хоризонтално
                        </h2>
                        <p class="mt-2 text-sm leading-relaxed text-zinc-300">
                            Играта е на пауза и ще продължи автоматично в пейзажен режим.
                        </p>
                        <button
                            type="button"
                            class="mt-5 min-h-11 rounded-xl border border-zinc-600 px-5 py-2.5 text-sm font-bold text-zinc-200"
                            @click="quit"
                        >
                            Назад към пистите
                        </button>
                    </div>
                </div>

                <!-- ── Преди старта: избор на трансмисия + управление ────── -->
                <Teleport to="body">
                    <!-- Без leave transition: състезанието тръгва в същия кадър
                         и модалът не трябва да остава върху активния canvas. -->
                    <template v-if="preStart">
                        <div
                            class="game-dialog-layer fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/65 p-2 backdrop-blur-sm sm:p-4"
                        >
                            <div
                                ref="preStartDialog"
                                tabindex="-1"
                                class="game-dialog-panel prestart-panel flex max-h-[calc(100dvh-1rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)]"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="prestart-title"
                            >
                                <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
                            <!-- Зареждащ екран: очертанието на пистата се дорисува с
                                 реалния прогрес (байтове), не с фалшив таймер. -->
                            <div class="prestart-heading flex items-center gap-4 border-b border-white/10 pb-5">
                                <svg
                                    v-if="outlineSvg"
                                    viewBox="-6 -6 112 112"
                                    class="h-20 w-20 shrink-0 sm:h-24 sm:w-24"
                                    aria-hidden="true"
                                >
                                    <path :d="outlineSvg" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4" stroke-linejoin="round" />
                                    <path
                                        :d="outlineSvg"
                                        fill="none"
                                        stroke="#e10600"
                                        stroke-width="4"
                                        stroke-linejoin="round"
                                        stroke-linecap="round"
                                        pathLength="1"
                                        stroke-dasharray="1"
                                        :stroke-dashoffset="loading ? 1 - loadProgress : 0"
                                        class="outline-draw"
                                    />
                                </svg>
                                <div class="min-w-0 flex-1">
                                    <p class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.22em] text-red-400">На стартовата решетка</p>
                                    <h2 id="prestart-title" class="font-display text-lg font-black uppercase tracking-wider text-zinc-100">
                                        {{ selectedTrack?.name }}
                                    </h2>
                                    <p class="mt-0.5 text-xs text-zinc-500">
                                        {{ rivals === 'race'
                                            ? `Състезание: ${raceTotalLaps} обиколки · стартираш от П${RIVAL_COUNT + 1}`
                                            : 'Готви се за квалификационна обиколка' }}
                                    </p>
                                    <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
                                        <span><span class="font-display font-bold tabular-nums text-zinc-300">{{ (selectedTrack.length / 1000).toFixed(3) }}</span> км</span>
                                        <span v-if="userBests.lap_ms !== null">
                                            PB <span class="font-display font-bold tabular-nums text-emerald-300">{{ formatMs(userBests.lap_ms) }}</span>
                                        </span>
                                        <span v-if="bests.lap_ms !== null">
                                            Рекорд <span class="font-display font-bold tabular-nums text-fuchsia-300">{{ formatMs(bests.lap_ms) }}</span>
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div class="mt-5">
                                <div class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                                    Режим на каране
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <button
                                        v-for="opt in [
                                            { v: 'race', l: 'Състезание', h: `${RIVAL_COUNT} съперници на пистата` },
                                            { v: 'solo', l: 'Сам на пистата', h: 'Чиста обиколка за атака' },
                                        ]"
                                        :key="opt.v"
                                        type="button"
                                        class="rounded-lg border p-3 text-left transition"
                                        :class="[
                                            rivals === opt.v ? 'border-[#e10600] bg-[#e10600]/10' : 'border-zinc-700 hover:border-zinc-500',
                                            opt.v === 'race' && rivalInfo ? 'cursor-not-allowed opacity-40' : '',
                                        ]"
                                        :aria-pressed="String(rivals === opt.v)"
                                        :disabled="opt.v === 'race' && rivalInfo !== null"
                                        @click="rivals = opt.v"
                                    >
                                        <div class="text-sm font-bold text-zinc-100">{{ opt.l }}</div>
                                        <div class="mt-0.5 text-[11px] text-zinc-400">{{ opt.h }}</div>
                                    </button>
                                </div>
                                <p v-if="rivals === 'race'" class="mt-1.5 text-[11px] text-zinc-500">
                                    Стартирате заедно от решетката (ти си П{{ RIVAL_COUNT + 1 }}) —
                                    светлините гаснат и потегляте, с истински контакт между колите.
                                    Общото време отива в класацията „Състезание" — +{{ RACE_PENALTY_SECONDS }} s за всяко излизане от пистата.
                                </p>
                            </div>

                            <!-- Телефон: избор как се завива; педалите са винаги явни. -->
                            <div v-if="isMobile" class="mt-4">
                                <div class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                                    Управление
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <button
                                        v-for="opt in [
                                            { v: 'buttons', l: 'Бутони', h: '◀ ▶ под левия палец' },
                                            { v: 'tilt', l: 'Накланяне', h: 'Телефонът е воланът' },
                                        ]"
                                        :key="opt.v"
                                        type="button"
                                        class="rounded-lg border p-3 text-left transition"
                                        :class="controlMode === opt.v ? 'border-[#e10600] bg-[#e10600]/10' : 'border-zinc-700 hover:border-zinc-500'"
                                        :aria-pressed="String(controlMode === opt.v)"
                                        @click="selectControlMode(opt.v)"
                                    >
                                        <div class="text-sm font-bold text-zinc-100">{{ opt.l }}</div>
                                        <div class="mt-0.5 text-[11px] text-zinc-400">{{ opt.h }}</div>
                                    </button>
                                </div>
                            </div>

                            <div v-if="!isMobile" class="mt-4">
                                <div class="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                                    Трансмисия
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <button
                                        v-for="opt in [
                                            { v: 'auto', l: 'Автоматична', h: 'Играта сменя предавките' },
                                            { v: 'manual', l: 'Ръчна', h: 'W нагоре · S надолу' },
                                        ]"
                                        :key="opt.v"
                                        type="button"
                                        class="rounded-lg border p-3 text-left transition"
                                        :class="transmission === opt.v ? 'border-[#e10600] bg-[#e10600]/10' : 'border-zinc-700 hover:border-zinc-500'"
                                        :aria-pressed="String(transmission === opt.v)"
                                        @click="transmission = opt.v"
                                    >
                                        <div class="text-sm font-bold text-zinc-100">{{ opt.l }}</div>
                                        <div class="mt-0.5 text-[11px] text-zinc-400">{{ opt.h }}</div>
                                    </button>
                                </div>
                            </div>

                            <!-- Графика + условия: пресетът се прилага веднага (setQuality) -->
                            <div class="mt-4 grid gap-2" :class="gameApi.weather ? 'grid-cols-2' : 'grid-cols-1'">
                                <label class="block">
                                    <span class="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Графика</span>
                                    <select
                                        :value="settings.quality"
                                        class="w-full rounded-lg border-zinc-700 bg-zinc-800/60 py-2 text-sm font-semibold text-zinc-100 focus:border-[#e10600] focus:ring-[#e10600]"
                                        @change="setQualityPreset($event.target.value)"
                                    >
                                        <option v-for="opt in QUALITY_OPTIONS" :key="opt.v" :value="opt.v">{{ opt.l }}</option>
                                    </select>
                                    <span class="mt-1 block text-[11px] leading-snug text-zinc-500">
                                        „Авто“ пази плавността. „Ултра“ добавя най-фините сенки и дълбочина само за мощен компютър.
                                    </span>
                                </label>
                                <div v-if="gameApi.weather">
                                    <span class="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Условия</span>
                                    <div class="grid grid-cols-2 gap-1.5">
                                        <button
                                            v-for="opt in [{ v: 'dry', l: 'Сухо' }, { v: 'wet', l: 'Мокро' }]"
                                            :key="opt.v"
                                            type="button"
                                            class="rounded-lg border py-2 text-sm font-bold transition"
                                            :class="settings.weather === opt.v ? 'border-[#e10600] bg-[#e10600]/10 text-zinc-100' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'"
                                            :aria-pressed="String(settings.weather === opt.v)"
                                            @click="setWeather(opt.v)"
                                        >
                                            {{ opt.l }}
                                        </button>
                                    </div>
                                    <p class="mt-1 text-[11px] text-zinc-500">Мокрото е само визуално — сцеплението не се променя.</p>
                                </div>
                            </div>

                            <div class="mt-4 rounded-lg bg-black/40 p-3">
                                <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                                    Управление
                                </div>
                                <!-- Телефон: накланяне/бутони + отделни педали. -->
                                <div v-if="isMobile" class="space-y-1.5 text-xs text-zinc-300">
                                    <div v-if="controlMode === 'tilt'">
                                        📱 <span class="font-semibold">Накланяй телефона</span> наляво/надясно, за да завиваш
                                    </div>
                                    <div v-else>
                                        🕹️ Завивай с бутоните <span class="font-semibold">◀ ▶</span> в долния ляв ъгъл
                                    </div>
                                    <div>🏎️ Задръж <span class="font-semibold">Газ</span> с десния палец, за да ускоряваш</div>
                                    <div>🛑 Пусни газта и задръж <span class="font-semibold">Спирачка</span> за завоите</div>
                                    <div>↻ След „Карай“ завърти телефона <span class="font-semibold">хоризонтално</span></div>
                                </div>
                                <!-- Десктоп: клавиатура -->
                                <div v-else class="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-300">
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">↑</kbd> газ</span>
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">↓</kbd> / <kbd class="rounded bg-zinc-800 px-1.5 py-0.5">Space</kbd> спирачка</span>
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">←</kbd> <kbd class="rounded bg-zinc-800 px-1.5 py-0.5">→</kbd> завиване</span>
                                    <span v-if="transmission === 'manual'" class="font-semibold text-amber-300">
                                        <kbd class="rounded bg-zinc-800 px-1.5 py-0.5">W</kbd> нагоре ·
                                        <kbd class="rounded bg-zinc-800 px-1.5 py-0.5">S</kbd> надолу
                                    </span>
                                    <span v-else><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">WASD</kbd> също работи</span>
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">R</kbd> рестарт</span>
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">C</kbd> камера</span>
                                    <span><kbd class="rounded bg-zinc-800 px-1.5 py-0.5">M</kbd> звук</span>
                                </div>
                            </div>

                                </div>

                                <!-- Отделен footer: primary CTA остава видим, докато
                                     настройките над него се скролват. -->
                                <div class="shrink-0 border-t border-white/10 bg-zinc-950/75 p-3 backdrop-blur sm:p-4">
                                    <p id="prestart-goal" class="mb-3 text-xs leading-relaxed text-zinc-200">
                                        <span class="font-bold text-white">Цел:</span>
                                        {{ rivals === 'race'
                                            ? `Завърши ${raceTotalLaps} обиколки. Потегли след изгасването на светлините.`
                                            : 'Мини стартовата линия, после завърши една пълна обиколка.' }}
                                    </p>
                                    <!-- Истински loading прогрес: болидът/средата по байтове -->
                                    <div v-if="loading" class="mb-3">
                                        <div class="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                                            <div
                                                class="h-full rounded-full bg-[#e10600] transition-all duration-200"
                                                :style="{ width: `${Math.round(loadProgress * 100)}%` }"
                                            ></div>
                                        </div>
                                        <div class="mt-1.5 text-center text-[11px] text-zinc-500" role="status">
                                            Зареждане… {{ Math.round(loadProgress * 100) }}%
                                        </div>
                                    </div>
                                    <div class="flex gap-2">
                                        <button
                                            ref="preStartCancel"
                                            type="button"
                                            class="rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm font-bold text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                                            @click="quit"
                                        >
                                            Отказ
                                        </button>
                                        <button
                                            ref="preStartCta"
                                            type="button"
                                            class="min-w-0 flex-1 rounded-xl bg-[#e10600] px-4 py-3 text-sm font-black uppercase tracking-wider text-white shadow-lg shadow-red-950/40 transition hover:bg-[#ff0800] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-60"
                                            aria-describedby="prestart-goal"
                                            :disabled="loading"
                                            @click="beginLap"
                                        >
                                            {{ loading ? 'Зареждане…' : 'Карай' }}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </template>
                </Teleport>

                <!-- ── Стартова процедура: петте светлини (състезание) ───── -->
                <Transition name="fade">
                    <div
                        v-if="launchLights !== null"
                        class="pointer-events-none absolute inset-x-0 z-30 flex justify-center"
                        :class="isMobile ? 'top-24' : 'top-16'"
                        aria-hidden="true"
                    >
                        <div class="flex gap-2.5 rounded-xl bg-black/70 px-5 py-3.5 backdrop-blur-sm">
                            <span
                                v-for="n in 5"
                                :key="n"
                                class="h-5 w-5 rounded-full transition-colors duration-150"
                                :class="n <= launchLights
                                    ? 'bg-red-500 shadow-[0_0_14px_rgba(239,68,68,0.9)]'
                                    : 'bg-zinc-800'"
                            ></span>
                        </div>
                    </div>
                </Transition>

                <!-- ── ТВ повторение: скорост / камера / скръбър / клип ──── -->
                <Transition name="fade">
                    <div
                        v-if="replaying"
                        class="absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-6"
                        style="padding-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px))"
                    >
                        <div class="w-full max-w-xl rounded-xl border border-zinc-700/70 bg-black/65 p-3 backdrop-blur-sm" role="group" aria-label="Повторение">
                            <!-- Скръбър със секторни тикове (само ако Game умее seek) -->
                            <div v-if="gameApi.replaySeek" class="relative mb-2 px-1">
                                <div class="pointer-events-none absolute inset-x-1 top-1/2 h-0 -translate-y-1/2">
                                    <span
                                        v-for="(tick, i) in replaySectorTicks"
                                        :key="i"
                                        class="absolute top-[-6px] h-3 w-px bg-zinc-400"
                                        :style="{ left: `${tick * 100}%` }"
                                    ></span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="1000"
                                    step="1"
                                    class="relative h-1 w-full cursor-pointer accent-[#e10600]"
                                    :value="Math.round((replayProgress ?? 0) * 1000)"
                                    aria-label="Позиция в повторението"
                                    @input="seekReplay(Number($event.target.value) / 1000)"
                                />
                            </div>
                            <div class="flex flex-wrap items-center justify-center gap-2">
                                <div v-if="gameApi.replaySpeed" class="flex gap-1" role="group" aria-label="Скорост на повторението">
                                    <button
                                        v-for="speed in REPLAY_SPEEDS"
                                        :key="speed"
                                        type="button"
                                        class="rounded px-2 py-1 font-display text-xs font-bold tabular-nums transition"
                                        :class="replaySpeed === speed ? 'bg-white/20 text-white' : 'text-zinc-400 hover:text-white'"
                                        :aria-pressed="String(replaySpeed === speed)"
                                        @click="setReplaySpeed(speed)"
                                    >
                                        {{ speed }}×
                                    </button>
                                </div>
                                <div v-if="gameApi.replayCamera" class="flex gap-1" role="group" aria-label="Камера на повторението">
                                    <button
                                        v-for="cam in REPLAY_CAMERAS"
                                        :key="cam.v"
                                        type="button"
                                        class="rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider transition"
                                        :class="replayCamera === cam.v ? 'bg-white/20 text-white' : 'text-zinc-400 hover:text-white'"
                                        :aria-pressed="String(replayCamera === cam.v)"
                                        @click="setReplayCamera(cam.v)"
                                    >
                                        {{ cam.l }}
                                    </button>
                                </div>
                                <button
                                    v-if="gameApi.clip"
                                    type="button"
                                    class="rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-300 transition hover:text-white disabled:opacity-50"
                                    :disabled="capturing"
                                    aria-label="Запиши 12-секунден клип"
                                    @click="recordClip"
                                >
                                    <span aria-hidden="true">📹</span> {{ capturing ? 'Записва…' : 'Клип' }}
                                </button>
                                <button
                                    type="button"
                                    class="rounded-full border border-zinc-600 bg-black/60 px-4 py-1.5 text-sm font-semibold text-zinc-100 transition hover:bg-black/80"
                                    :class="hasReplayControls ? '' : 'px-5 py-2.5'"
                                    @click="stopReplay"
                                >
                                    ■ Спри повторението
                                </button>
                            </div>
                        </div>
                    </div>
                </Transition>

                <!-- ── Връщане на пистата: брояч 3-2-1 ──────────────────── -->
                <!-- Скрит по време на стартовата процедура: телеметрията
                     замръзва при отброяването и старият флаг би висял отгоре. -->
                <Transition name="fade">
                    <div
                        v-if="telemetry.recovering && launchLights === null"
                        class="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/45"
                        aria-hidden="true"
                    >
                        <div class="text-xs font-bold uppercase tracking-[0.3em] text-amber-300">
                            Връщане на пистата
                        </div>
                        <div
                            :key="telemetry.recoverCount"
                            class="gear-pop font-display text-8xl font-black tabular-nums text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.9)]"
                        >
                            {{ telemetry.recoverCount }}
                        </div>
                    </div>
                </Transition>

                <!-- ── Подиум: финалът на състезанието ───────────────────── -->
                <Teleport to="body">
                    <Transition name="fade">
                        <div
                            v-if="raceResult && !replaying"
                            class="game-dialog-layer fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/75 p-2 backdrop-blur-sm sm:p-4"
                        >
                            <div
                                ref="podiumDialog"
                                tabindex="-1"
                                class="game-dialog-panel flex max-h-[calc(100dvh-1rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)]"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="podium-title"
                            >
                                <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
                            <!-- Кариран флаг -->
                            <div class="mb-4 overflow-hidden rounded" aria-hidden="true">
                                <svg viewBox="0 0 120 8" preserveAspectRatio="none" class="h-2 w-full">
                                    <defs>
                                        <pattern id="chequer-race" width="8" height="8" patternUnits="userSpaceOnUse">
                                            <rect width="8" height="8" fill="#fafafa" />
                                            <rect width="4" height="4" fill="#0a0a0a" />
                                            <rect x="4" y="4" width="4" height="4" fill="#0a0a0a" />
                                        </pattern>
                                    </defs>
                                    <rect width="120" height="8" fill="url(#chequer-race)" />
                                </svg>
                            </div>

                            <div class="mb-1 flex items-center justify-center gap-2">
                                <span class="text-2xl" aria-hidden="true">🏁</span>
                                <h2 id="podium-title" class="font-display text-lg font-black uppercase tracking-wider text-zinc-100">
                                    Финал на състезанието
                                </h2>
                            </div>
                            <p class="mb-4 text-center text-xs text-zinc-500">
                                {{ selectedTrack?.name }} · {{ telemetry.raceTotalLaps }} обиколки
                            </p>

                            <div class="text-center">
                                <div
                                    class="font-display text-5xl font-black tabular-nums"
                                    :class="raceResult.position === 1 ? 'text-amber-300' : 'text-white'"
                                >
                                    П{{ raceResult.position }}
                                </div>
                                <div v-if="raceResult.position === 1" class="mt-1 text-sm font-bold uppercase tracking-widest text-amber-400">
                                    Победа! 🏆
                                </div>
                            </div>

                            <!-- Общо време за класацията „Състезание" -->
                            <div class="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 text-center">
                                <div class="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Общо време</div>
                                <div class="font-display text-3xl font-black tabular-nums text-zinc-100">
                                    {{ formatMs(raceResult.totalMs) }}
                                </div>
                                <div class="mt-0.5 text-xs tabular-nums" :class="raceResult.penalties > 0 ? 'text-red-300' : 'text-zinc-500'">
                                    <template v-if="raceResult.penalties > 0">
                                        {{ formatMs(raceResult.raceMs) }} + {{ raceResult.penalties }} × {{ RACE_PENALTY_SECONDS }} s
                                        <span class="text-zinc-400">
                                            ({{ [
                                                raceResult.trackLimits ? `излизания: ${raceResult.trackLimits}` : null,
                                                raceResult.contactFaults ? `удари: ${raceResult.contactFaults}` : null,
                                            ].filter(Boolean).join(', ') }})
                                        </span>
                                    </template>
                                    <template v-else>Без наказания</template>
                                </div>

                                <div v-if="raceSubmitting" class="mt-2 text-xs text-zinc-400" role="status">
                                    Записване…
                                </div>
                                <div v-else-if="raceSubmitError" class="mt-2 text-xs text-red-400" role="alert">
                                    {{ raceSubmitError }}
                                </div>
                                <div v-else-if="raceMeta" class="mt-2 flex flex-wrap items-center justify-center gap-2 text-xs">
                                    <span
                                        v-if="raceMeta.personal_best"
                                        class="rounded-full bg-emerald-500/20 px-2.5 py-1 font-semibold text-emerald-300"
                                    >
                                        Личен рекорд!
                                    </span>
                                    <span class="text-zinc-300">
                                        №{{ raceMeta.rank }} в класацията „Състезание"
                                    </span>
                                </div>
                                <div v-else-if="!authUser" class="mt-2 text-xs text-zinc-300">
                                    <a href="/login" class="font-semibold text-[#e10600] hover:underline">Влез</a>,
                                    за да запишеш времето си в класацията.
                                </div>
                                <div v-else-if="!raceHasTrace" class="mt-2 text-xs text-zinc-500">
                                    Състезанието е твърде дълго за запис — не влиза в класацията.
                                </div>
                            </div>

                            <!-- Подиумът: 2-1-3 -->
                            <div class="mt-5 flex items-end justify-center gap-2">
                                <div
                                    v-for="slot in [2, 1, 3]"
                                    :key="slot"
                                    class="flex w-24 flex-col items-center"
                                >
                                    <div
                                        class="mb-1 w-full truncate text-center text-[11px] font-semibold"
                                        :class="raceResult.standings[slot - 1]?.isPlayer ? 'text-fuchsia-300' : 'text-zinc-300'"
                                    >
                                        {{ raceResult.standings[slot - 1]?.isPlayer ? 'Ти' : raceResult.standings[slot - 1]?.name }}
                                    </div>
                                    <div
                                        class="flex w-full items-start justify-center rounded-t font-display text-lg font-black tabular-nums"
                                        :class="[
                                            slot === 1 ? 'h-16 bg-amber-400/90 text-zinc-900'
                                                : slot === 2 ? 'h-12 bg-zinc-400/90 text-zinc-900'
                                                : 'h-9 bg-amber-700/90 text-zinc-100',
                                        ]"
                                    >
                                        {{ slot }}
                                    </div>
                                </div>
                            </div>

                            <!-- Задочна битка: общото време срещу реалното състезание на съперника -->
                            <div
                                v-if="raceResult.rival"
                                class="mt-3 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-center text-sm text-zinc-200"
                            >
                                Срещу {{ raceResult.rival.name }}:
                                <span
                                    class="font-display font-bold tabular-nums"
                                    :class="raceResult.rival.deltaMs <= 0 ? 'text-emerald-300' : 'text-red-300'"
                                >{{ raceResult.rival.deltaMs <= 0 ? '−' : '+' }}{{ (Math.abs(raceResult.rival.deltaMs) / 1000).toFixed(3) }} s</span>
                                <div class="text-xs text-zinc-400">{{ raceResult.rival.deltaMs <= 0 ? 'Би го!' : 'Този път не стигна.' }}</div>
                            </div>

                            <!-- Класирането: време + наказания; ботовете зад теб доизкарват -->
                            <ol class="mt-4 space-y-1 border-t border-zinc-800 pt-3">
                                <li
                                    v-for="row in raceResult.classification ?? []"
                                    :key="row.position"
                                    class="flex items-baseline justify-between gap-3 text-sm"
                                    :class="row.isPlayer ? 'font-bold text-fuchsia-300' : 'text-zinc-300'"
                                >
                                    <span class="min-w-0 truncate">
                                        <span class="tabular-nums text-zinc-500">{{ row.position }}.</span>
                                        {{ row.isPlayer ? 'Ти' : row.name }}
                                        <span
                                            v-if="row.fastestLap"
                                            class="ml-1 rounded bg-fuchsia-600/30 px-1 text-[10px] font-bold text-fuchsia-200"
                                            :title="`Най-бърза обиколка ${formatMs(row.bestLapMs)}`"
                                        >⏱ {{ formatMs(row.bestLapMs) }}</span>
                                        <span v-if="row.penalties > 0" class="ml-1 text-[11px] font-semibold text-red-300">+{{ row.penalties * RACE_PENALTY_SECONDS }} s</span>
                                    </span>
                                    <span class="shrink-0 font-display text-xs font-bold tabular-nums text-zinc-400">
                                        {{ classificationTime(row) }}
                                    </span>
                                </li>
                            </ol>
                            <p v-if="!raceResult.final" class="mt-2 text-center text-[11px] text-zinc-500" role="status">
                                Временно класиране — полето още финишира.
                            </p>
                                </div>

                                <div class="grid shrink-0 grid-cols-2 gap-2 border-t border-white/10 bg-zinc-950/75 p-3 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:p-4">
                                <button
                                    ref="podiumCta"
                                    type="button"
                                    class="col-span-2 min-h-11 rounded-xl bg-[#e10600] px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-[#ff0800] sm:col-span-1"
                                    @click="newRace"
                                >
                                    Ново състезание
                                </button>
                                <button
                                    type="button"
                                    class="min-h-11 min-w-11 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                                    aria-label="Повторение"
                                    title="Повторение"
                                    @click="startReplay"
                                >
                                    <span aria-hidden="true">📺</span>
                                </button>
                                <button
                                    type="button"
                                    class="min-h-11 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                                    @click="quit"
                                >
                                    Смени пистата
                                </button>
                                <button v-if="authUser && hasPlayed && !feedbackSaved" type="button" class="col-span-full min-h-11 rounded-xl px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800" @click="openGameFeedback">Мнение за играта</button>
                            </div>
                                </div>
                            </div>
                    </Transition>
                </Teleport>

                <!-- ── Резултат: кариран флаг + времена + класация ─────── -->
                <Teleport to="body">
                    <Transition name="fade">
                        <div
                            v-if="result && !replaying"
                            class="game-dialog-layer fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/75 p-2 backdrop-blur-sm sm:p-4"
                        >
                            <div
                                ref="resultDialog"
                                tabindex="-1"
                                class="game-dialog-panel flex max-h-[calc(100dvh-1rem)] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl outline-none sm:max-h-[calc(100dvh-2rem)]"
                                :class="analysis ? 'max-w-2xl' : 'max-w-md'"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="result-title"
                            >
                                <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
                            <!-- Кариран флаг -->
                            <div class="mb-4 overflow-hidden rounded" aria-hidden="true">
                                <svg viewBox="0 0 120 8" preserveAspectRatio="none" class="h-2 w-full">
                                    <defs>
                                        <pattern id="chequer" width="8" height="8" patternUnits="userSpaceOnUse">
                                            <rect width="8" height="8" fill="#fafafa" />
                                            <rect width="4" height="4" fill="#0a0a0a" />
                                            <rect x="4" y="4" width="4" height="4" fill="#0a0a0a" />
                                        </pattern>
                                    </defs>
                                    <rect width="120" height="8" fill="url(#chequer)" />
                                </svg>
                            </div>

                            <!-- Първо място в класацията на пистата → трофей -->
                            <div v-if="isFirstPlace" class="mb-4 flex flex-col items-center">
                                <img
                                    src="/game-textures/trophy/trophy.png"
                                    alt="Трофей за първо място"
                                    class="h-28 w-auto drop-shadow-[0_8px_22px_rgba(234,179,8,0.5)]"
                                />
                                <div class="mt-1 font-display text-base font-black uppercase tracking-[0.2em] text-amber-400">
                                    Първо място!
                                </div>
                                <div class="text-[11px] text-zinc-400">
                                    Най-бързата обиколка на пистата — от всички
                                </div>
                            </div>

                            <div class="mb-1 flex items-center justify-center gap-2">
                                <span class="text-2xl" aria-hidden="true">🏁</span>
                                <h2 id="result-title" class="font-display text-lg font-black uppercase tracking-wider text-zinc-100">
                                    {{ result.valid ? 'Финал' : 'Край на обиколката' }}
                                </h2>
                            </div>
                            <p class="mb-4 text-center text-xs text-zinc-500">
                                {{ selectedTrack?.name }} · квалификационна обиколка
                            </p>

                            <!-- Табове: времена / анализ (само ако Game дава анализ) -->
                            <div v-if="analysis" class="mb-4 flex justify-center gap-1.5" role="tablist">
                                <button
                                    v-for="tab in [{ v: 'times', l: 'Времена' }, { v: 'analysis', l: 'Анализ' }]"
                                    :key="tab.v"
                                    type="button"
                                    role="tab"
                                    class="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition"
                                    :class="resultTab === tab.v ? 'bg-[#e10600]/20 text-[#ff5a55]' : 'bg-zinc-800/70 text-zinc-400 hover:text-zinc-200'"
                                    :aria-selected="String(resultTab === tab.v)"
                                    @click="resultTab = tab.v"
                                >
                                    {{ tab.l }}
                                </button>
                            </div>

                            <LapAnalysis
                                v-if="analysis && resultTab === 'analysis'"
                                :analysis="analysis"
                                :sector-states="resultSectorStates"
                                :outline="trackOutline"
                            />

                            <template v-else>
                                <!-- Време на обиколката (count-up от нула) -->
                                <div class="text-center">
                                    <div
                                        class="font-display text-4xl font-black tabular-nums sm:text-5xl"
                                        :class="lapTextClass"
                                    >
                                        {{ formatMs(displayedLapMs ?? result.lapMs) }}
                                    </div>
                                    <div class="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-0.5 font-display text-xs font-bold tabular-nums">
                                        <span v-if="resultDeltaPb" class="text-zinc-400">
                                            <span class="font-sans font-normal text-zinc-500">спрямо личния</span>
                                            <span :class="resultDeltaPb.startsWith('+') ? 'text-red-400' : 'text-emerald-400'">{{ resultDeltaPb }}</span>
                                        </span>
                                        <span v-if="resultDeltaRecord" class="text-zinc-400">
                                            <span class="font-sans font-normal text-zinc-500">спрямо рекорда</span>
                                            <span :class="resultDeltaRecord.startsWith('+') ? 'text-red-400' : 'text-fuchsia-400'">{{ resultDeltaRecord }}</span>
                                        </span>
                                    </div>
                                    <div
                                        v-if="bests.lap_ms !== null"
                                        class="mt-1 font-display text-xs font-bold tabular-nums text-fuchsia-400/70"
                                    >
                                        Рекорд на пистата: {{ formatMs(bests.lap_ms) }}
                                    </div>
                                </div>

                                <!-- Сектори (стагер при появяване) -->
                                <div class="mt-4 grid grid-cols-3 gap-2">
                                    <div
                                        v-for="(sec, i) in result.sectorsMs"
                                        :key="i"
                                        class="sector-in rounded-lg border p-2 text-center"
                                        :class="sectorCellClass(i)"
                                        :style="{ animationDelay: `${i * 90}ms` }"
                                    >
                                        <div class="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                                            Сектор {{ i + 1 }}
                                        </div>
                                        <div
                                            class="font-display text-base font-bold tabular-nums"
                                            :class="sectorTextClass(i)"
                                        >
                                            {{ formatSectorMs(sec) }}
                                        </div>
                                        <div
                                            v-if="bests.sectors_ms[i] !== null"
                                            class="mt-0.5 font-display text-[11px] font-bold tabular-nums text-fuchsia-400/70"
                                        >
                                            {{ formatSectorMs(bests.sectors_ms[i]) }}
                                        </div>
                                    </div>
                                </div>

                                <!-- Значки: позиция / рекорд -->
                                <div
                                    v-if="resultMeta"
                                    class="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs"
                                >
                                    <span class="rounded-full bg-zinc-800 px-2.5 py-1 font-semibold text-zinc-200">
                                        Позиция #{{ resultMeta.rank }}
                                    </span>
                                    <span
                                        v-if="resultMeta.purple_lap"
                                        class="rounded-full bg-fuchsia-500/20 px-2.5 py-1 font-semibold text-fuchsia-300"
                                    >
                                        Рекорд на пистата!
                                    </span>
                                    <span
                                        v-else-if="resultMeta.personal_best"
                                        class="rounded-full bg-emerald-500/20 px-2.5 py-1 font-semibold text-emerald-300"
                                    >
                                        Личен рекорд!
                                    </span>
                                </div>

                                <!-- Статус на записа -->
                                <div v-if="submitting" class="mt-3 text-center text-xs text-zinc-400" role="status">
                                    Записване…
                                </div>
                                <div v-if="submitError" class="mt-3 text-center text-xs text-red-400" role="alert">
                                    {{ submitError }}
                                </div>
                                <div
                                    v-if="!result.valid"
                                    class="mt-3 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-center text-xs text-amber-300"
                                >
                                    Невалидна обиколка (излизане извън трасето) — не влиза в класацията.
                                </div>
                                <div
                                    v-else-if="!authUser"
                                    class="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-center text-xs text-zinc-300"
                                >
                                    <a href="/login" class="font-semibold text-[#e10600] hover:underline">Влез</a>,
                                    за да запишеш времето си в класацията.
                                </div>

                                <!-- Класация -->
                                <div v-if="leaderboard.length" class="mt-4 border-t border-zinc-800 pt-3">
                                    <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                                        Класация
                                    </div>
                                    <ol class="space-y-1">
                                        <li
                                            v-for="(row, idx) in leaderboard"
                                            :key="idx"
                                            class="flex items-center justify-between gap-2 text-sm"
                                            :class="row.is_you ? 'text-fuchsia-300' : 'text-zinc-300'"
                                        >
                                            <span class="min-w-0 truncate">
                                                <span class="tabular-nums text-zinc-500">{{ idx + 1 }}.</span>
                                                <a
                                                    :href="`/profiles/${row.user_id}`"
                                                    class="transition hover:text-white hover:underline"
                                                >{{ row.name }}</a>
                                            </span>
                                            <span class="flex shrink-0 items-center gap-1.5">
                                                <span class="font-display text-xs font-bold tabular-nums">{{ formatMs(row.lap_ms) }}</span>
                                                <button
                                                    v-if="row.has_ghost && !row.is_you"
                                                    type="button"
                                                    class="rounded bg-fuchsia-500/15 px-2 py-1 text-[11px] font-bold text-fuchsia-300 transition hover:bg-fuchsia-500/30"
                                                    title="Дуел срещу духа на тази обиколка"
                                                    :aria-label="`Дуел срещу ${row.name}`"
                                                    @click="duelFromBoard(row)"
                                                >
                                                    <span aria-hidden="true">👻</span>
                                                </button>
                                                <button
                                                    v-if="row.has_ghost"
                                                    type="button"
                                                    class="rounded bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-300 transition hover:bg-zinc-700"
                                                    title="Копирай линк-покана към този дуел"
                                                    :aria-label="copiedChallenge === `result:${row.user_id}` ? 'Линкът е копиран' : `Копирай линк за дуел срещу ${row.name}`"
                                                    @click="copyChallenge(selectedTrack.slug, row.user_id, `result:${row.user_id}`)"
                                                >
                                                    <span aria-hidden="true">{{ copiedChallenge === `result:${row.user_id}` ? '✓' : '🔗' }}</span>
                                                </button>
                                            </span>
                                        </li>
                                    </ol>
                                </div>
                            </template>

                                </div>

                                <!-- Действията са извън scroll областта: основният
                                     бутон остава достижим и на нисък landscape екран. -->
                                <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 border-t border-white/10 bg-zinc-950/75 p-3 backdrop-blur sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:p-4">
                                <button
                                    ref="resultCta"
                                    type="button"
                                    class="col-span-3 min-h-11 rounded-xl bg-[#e10600] px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-[#ff0800] sm:col-span-1"
                                    @click="newLap"
                                >
                                    Нова обиколка
                                </button>
                                <button
                                    type="button"
                                    class="min-h-11 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                                    aria-label="Повторение"
                                    @click="startReplay"
                                >
                                    <span aria-hidden="true">📺</span> Повторение
                                </button>
                                <button
                                    type="button"
                                    class="min-h-11 min-w-11 rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
                                    :disabled="sharing"
                                    title="Сподели резултата (PNG за Telegram)"
                                    aria-label="Сподели резултата"
                                    @click="shareResult"
                                >
                                    <span aria-hidden="true">📤</span>
                                </button>
                                <button
                                    type="button"
                                    class="min-h-11 rounded-xl border border-zinc-700 px-3 py-2.5 text-sm font-semibold text-zinc-300 transition hover:bg-zinc-800"
                                    @click="quit"
                                >
                                    Смени пистата
                                </button>
                                <button v-if="authUser && hasPlayed && !feedbackSaved" type="button" class="col-span-full min-h-11 rounded-xl px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800" @click="openGameFeedback">Мнение за играта</button>
                                </div>
                            </div>
                        </div>
                    </Transition>
                </Teleport>
            </div>
        </div>
    </PublicLayout>
</template>

<style scoped>
/* Игровата сцена излиза от max-width/padding-а на PublicLayout, но остава
   точно между sticky header-а и долния ръб на viewport-а. */
.game-stage:not(.game-stage-mobile) {
    width: 100vw;
    margin-left: calc(50% - 50vw);
}

/* Плътен контраст и обща рамка върху слънце, асфалт и нощна сцена. */
.instrument-panel {
    background: linear-gradient(135deg, rgba(20, 24, 29, 0.96), rgba(8, 11, 15, 0.9));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 6px 24px rgba(0, 0, 0, 0.16);
}

.timing-panel {
    min-width: 11rem;
}

.speed-panel {
    min-width: 15rem;
}

.speed-readout {
    min-width: 3.1ch;
}

.gear-cell {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.04);
}

.race-tower-player {
    margin-inline: -0.4rem;
    padding-inline: 0.4rem;
    background: linear-gradient(90deg, rgba(225, 6, 0, 0.3), rgba(225, 6, 0, 0.06));
    box-shadow: inset 2px 0 #e10600;
}

.game-toolbar > [role='group'],
.game-toolbar > div:not([role='group']) > button {
    background-color: rgba(12, 16, 21, 0.9);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.game-toolbar > div:not([role='group']) > button:hover {
    background-color: rgba(35, 40, 47, 0.97);
}

.game-stage-mobile .timing-panel,
.game-stage-mobile .speed-panel {
    min-width: 0;
}

.prestart-panel {
    background: linear-gradient(145deg, #1c1e22, #101216 65%);
    border-top: 2px solid #e10600;
}

.prestart-heading svg {
    padding: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 8px;
    background: linear-gradient(145deg, rgba(225, 6, 0, 0.09), rgba(255, 255, 255, 0.02));
}

.prestart-panel button[aria-pressed='true'] {
    box-shadow: inset 0 0 0 1px rgba(225, 6, 0, 0.35);
}

/* Каталогът използва реалния силует и авторския look preset на всяка писта. */
.track-card {
    background:
        radial-gradient(circle at 82% 10%, var(--track-glow), transparent 43%),
        linear-gradient(145deg, var(--track-sky), var(--track-ground) 72%);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.2);
}

.track-card::after {
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: linear-gradient(115deg, rgba(255, 255, 255, 0.06), transparent 34%);
    content: '';
    pointer-events: none;
}

.track-card:hover,
.track-card:focus-within {
    border-color: color-mix(in srgb, var(--track-accent) 62%, transparent);
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.36), 0 0 32px var(--track-glow);
    transform: translateY(-3px);
}

.track-card-visual {
    background:
        linear-gradient(to top, rgba(0, 0, 0, 0.58), transparent 65%),
        radial-gradient(circle at 76% 42%, var(--track-glow), transparent 52%);
}

/* Текстът е в собствен непрозрачен слой под изрязаната визуализация. Така
   контурът не може да го покрие при тесни laptop карти или mobile landscape. */
.track-card-copy {
    background: linear-gradient(180deg, rgba(9, 9, 11, 0.34), rgba(9, 9, 11, 0.68));
}

.track-card-name {
    overflow-wrap: anywhere;
}

.track-card-grid {
    background-image:
        linear-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.08) 1px, transparent 1px);
    background-size: 20px 20px;
    mask-image: linear-gradient(to right, black, transparent 78%);
}

.track-card-outline {
    filter: drop-shadow(0 0 9px var(--track-glow));
    transition: filter 0.3s ease, transform 0.3s ease;
}

.track-card:hover .track-card-outline,
.track-card:focus-within .track-card-outline {
    filter: drop-shadow(0 0 14px var(--track-accent));
    transform: scale(1.035) rotate(-1deg);
}

.track-card:hover .track-card-arrow,
.track-card:focus-within .track-card-arrow {
    border-color: var(--track-accent);
    background: var(--track-accent);
    color: #09090b;
    transform: translate(2px, -2px);
}

/* Teleport-натите диалози могат да inert-нат целия PublicLayout и спазват
   safe-area отстъпите на телефони с прорез/gesture bar. */
.game-dialog-layer {
    padding-top: max(0.5rem, env(safe-area-inset-top, 0px));
    padding-right: max(0.5rem, env(safe-area-inset-right, 0px));
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px));
    padding-left: max(0.5rem, env(safe-area-inset-left, 0px));
}

.game-dialog-panel {
    box-shadow: 0 28px 90px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.025);
}

.game-dialog-panel [class*='overflow-y-auto'] {
    scrollbar-color: rgba(161, 161, 170, 0.55) transparent;
    scrollbar-width: thin;
}

/* HUD е закотвен към safe-area, а при нисък viewport вторичната телеметрия
   отстъпва, за да останат пистата, таймерът и скоростта четими. */
.game-toolbar {
    top: clamp(0.75rem, 2vw, 1.5rem);
    right: clamp(0.75rem, 2vw, 1.5rem);
}

.game-stage-mobile .game-toolbar {
    top: max(0.75rem, env(safe-area-inset-top, 0px));
    right: max(0.75rem, env(safe-area-inset-right, 0px));
}

.game-stage-mobile .hud-timing {
    top: max(0.75rem, env(safe-area-inset-top, 0px)) !important;
    left: max(0.75rem, env(safe-area-inset-left, 0px)) !important;
}

.game-stage-mobile .hud-speed {
    right: max(0.75rem, env(safe-area-inset-right, 0px)) !important;
}

@media (orientation: landscape) {
    .game-stage-mobile .hud-timing {
        /* Оставя 12 px пред центрираната миникарта (72 px), включително
           когато прорезът на телефона измества левия край на HUD-а. */
        max-width: min(20rem, calc(50vw - 3rem - max(0.75rem, env(safe-area-inset-left, 0px))));
    }

    .game-stage-mobile .timing-panel {
        overflow-wrap: anywhere;
    }
}

.mobile-controls {
    padding-top: 0.75rem;
    padding-right: max(1rem, env(safe-area-inset-right, 0px));
    padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px));
    padding-left: max(1rem, env(safe-area-inset-left, 0px));
}

.mobile-control-button,
.mobile-pedal-button {
    height: clamp(3.75rem, 20dvh, 5rem);
}

.mobile-control-button {
    width: clamp(4rem, 12vw, 6rem);
}

.mobile-pedal-button {
    width: clamp(4.75rem, 14vw, 6.75rem);
}

.mobile-recenter {
    min-height: clamp(3.75rem, 20dvh, 5rem);
}

@media (orientation: landscape) and (max-height: 360px) {
    .mobile-controls {
        padding-top: 0.5rem;
        padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px));
    }

    .mobile-control-button,
    .mobile-pedal-button,
    .mobile-recenter {
        height: 3.5rem;
        min-height: 3.5rem;
    }
}

@media (max-height: 620px) {
    .game-hud .hud-secondary {
        display: none;
    }

    .game-dialog-panel {
        border-radius: 0.75rem;
    }
}

@media (max-width: 640px) and (orientation: portrait) {
    .game-stage-mobile .hud-timing {
        max-width: calc(100vw - 12.5rem);
    }

    .game-stage-mobile .hud-timing > div:first-child {
        max-width: 100%;
    }

    .game-stage-mobile .hud-minimap {
        top: 5rem !important;
        right: max(0.75rem, env(safe-area-inset-right, 0px)) !important;
        left: auto !important;
        transform: none !important;
    }

    .game-stage-mobile .hud-speed {
        top: 10.25rem !important;
    }
}

/* Предавката „подскача" при смяна — key-ът в шаблона рестартира анимацията. */
@keyframes gear-pop {
    0% {
        transform: scale(1.4);
    }
    100% {
        transform: scale(1);
    }
}

.gear-pop {
    animation: gear-pop 0.16s ease-out;
}

/* Сплитът светва за 300 ms при появяване (ре-key на чипа) — вместо
   TransitionGroup, чийто leave би оставил стария чип до новия в реда. */
@keyframes split-flash {
    0% {
        background-color: rgba(255, 255, 255, 0.85);
        transform: scale(1.08);
    }
    100% {
        background-color: rgba(0, 0, 0, 0.5);
        transform: scale(1);
    }
}

.split-flash {
    animation: split-flash 0.3s ease-out;
}

/* Таймерът просветва при завършена обиколка (ре-key по lapFlashKey). */
@keyframes lap-flash {
    0% {
        opacity: 0.2;
    }
    30% {
        opacity: 1;
    }
    60% {
        opacity: 0.4;
    }
    100% {
        opacity: 1;
    }
}

.lap-flash {
    animation: lap-flash 0.6s ease-out;
}

/* Секторите в резултата влизат със стагер (animation-delay от шаблона). */
@keyframes sector-in {
    0% {
        opacity: 0;
        transform: translateY(6px);
    }
    100% {
        opacity: 1;
        transform: translateY(0);
    }
}

.sector-in {
    animation: sector-in 0.35s ease-out both;
}

/* Спинерът на картата при зареждане. */
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

.spinner {
    animation: spin 0.8s linear infinite;
}

/* Очертанието се дорисува плавно между два прогрес-тика. */
.outline-draw {
    transition: stroke-dashoffset 0.25s ease-out;
}

/* Overlay-ите влизат/излизат с fade + лек скейл. */
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.22s ease, transform 0.22s ease;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
    transform: scale(0.985);
}

/* Визьор на каската: тъмен горен ръб + странично засенчване. */
.visor {
    background:
        linear-gradient(to bottom, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0) 16%),
        radial-gradient(ellipse 78% 92% at 50% 60%, transparent 70%, rgba(0, 0, 0, 0.75) 100%);
}

/* Компактен HUD: само таймер, сплитове, предавка и скорост. */
.hud-compact .hud-secondary {
    display: none;
}

/* Reduced motion: без анимации и преходи (както в Quiz/BadgeAwardToast). */
@media (prefers-reduced-motion: reduce) {
    .gear-pop,
    .split-flash,
    .lap-flash,
    .sector-in {
        animation: none;
    }

    .fade-enter-active,
    .fade-leave-active,
    .outline-draw,
    .track-card,
    .track-card-outline,
    .track-card-arrow {
        transition: none;
    }

    .track-card:hover,
    .track-card:focus-within,
    .track-card:hover .track-card-outline,
    .track-card:focus-within .track-card-outline,
    .track-card:hover .track-card-arrow,
    .track-card:focus-within .track-card-arrow {
        transform: none;
    }
}
</style>
