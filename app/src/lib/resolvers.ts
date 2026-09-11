/*
 * Парсер кэша списка резольверов dnscrypt (public-resolvers.md).
 * Формат: секции "## имя" с описанием и sdns:// штампами.
 * Свойства (DNSSEC/NOLOG/NOFILTER) и протокол зашиты в штампе:
 *   байт 0 — протокол (1=DNSCrypt, 2=DoH, 3=DoT, 4=DoQ)
 *   байт 1 — битовая маска: 1=DNSSEC, 2=NOLOG, 4=NOFILTER
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ResolverInfo {
    name: string;
    protos: string[];
    dnssec: boolean;
    nolog: boolean;
    nofilter: boolean;
    description: string;
}

export type ResolversResult = { ok: true; list: ResolverInfo[] } | { ok: false; error: string };

const PROTO_NAMES: Record<number, string> = { 1: 'DNSCrypt', 2: 'DoH', 3: 'DoT', 4: 'DoQ' };

interface Stamp {
    proto: number;
    props: number;
}

function decodeStamp(b64: string): Stamp | null {
    try {
        const buf = Buffer.from(b64, 'base64url');
        if (buf.length < 2) return null;
        return { proto: buf[0], props: buf[1] };
    } catch (e) {
        return null;
    }
}

export function parseResolvers(mdText: string): ResolverInfo[] {
    const out: ResolverInfo[] = [];
    const sections = mdText.split(/^## /m).slice(1);
    for (const section of sections) {
        const nl = section.indexOf('\n');
        if (nl === -1) continue;
        const name = section.slice(0, nl).trim();
        if (!name) continue;
        const body = section.slice(nl + 1);
        const description = body.split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith('sdns://'))
            .join(' ')
            .slice(0, 220);

        const protos = new Set<string>();
        let props = 0;
        let haveStamp = false;
        for (const m of body.matchAll(/sdns:\/\/([A-Za-z0-9_-]+)/g)) {
            const st = decodeStamp(m[1]);
            if (!st) continue;
            haveStamp = true;
            if (PROTO_NAMES[st.proto]) protos.add(PROTO_NAMES[st.proto]);
            props |= st.props;
        }
        if (!haveStamp) continue;

        out.push({
            name,
            protos: [...protos],
            dnssec: Boolean(props & 1),
            nolog: Boolean(props & 2),
            nofilter: Boolean(props & 4),
            description,
        });
    }
    return out;
}

/* Читает кэш из каталога конфигов. Файл появляется после первого успешного
 * запуска dnscrypt-proxy (он обновляет его сам по refresh_delay). */
export function readResolvers(configDir: string): ResolversResult {
    const file = path.join(configDir, 'public-resolvers.md');
    let md: string;
    try {
        md = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { ok: false, error: 'Список ещё не загружен — запустите DNSCrypt, он скачает его сам.' };
    }
    return { ok: true, list: parseResolvers(md) };
}
