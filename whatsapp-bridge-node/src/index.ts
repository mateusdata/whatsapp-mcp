import WAWebJS, { MessageMedia } from 'whatsapp-web.js';
import type { Message, Chat, Contact, GroupChat } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import Knex from 'knex';
import crypto from 'crypto';
import { EventEmitter } from 'events';


let client: WAWebJS.Client;
let clientReadyTimestamp: Date | null = null;
const eventEmitter = new EventEmitter();
let historySyncComplete = false;
let totalHistoryMessages = 0;
let processedHistoryMessages = 0;


interface SendMessageRequest {
    recipient: string;
    message?: string;
    mediaPath?: string;
}

interface SendMessageResponse {
    success: boolean;
    message: string;
    error?: string;
}

interface DownloadMediaRequest {
    message_id: string;
    chat_jid: string;
}

interface DownloadMediaResponse {
    success: boolean;
    message: string;
    filename?: string;
    path?: string;
    error?: string;
}

interface StoredMessage {
    id: string;
    chat_jid: string;
    sender: string;
    content: string;
    timestamp: string | null;
    is_from_me: boolean;
    media_type: string | null;
    filename: string | null;
    local_path: string | null;
    media_url: string | null;
    media_key: Buffer | null;
    media_file_hash: Buffer | null;
    media_file_enc_hash: Buffer | null;
    media_file_length: number | null;
}


const knex = Knex({
    client: 'sqlite3',
    connection: {
        filename: './store/messages.db',
    },
    useNullAsDefault: true,
    pool: {
        min: 1,
        max: 10,
        afterCreate: (conn: any, cb: any) => {
            conn.run('PRAGMA foreign_keys = ON', cb);
            conn.run('PRAGMA journal_mode = WAL', cb);
            conn.run('PRAGMA cache_size = 20000', cb);
            conn.run('PRAGMA synchronous = NORMAL', cb);
            conn.run('PRAGMA temp_store = MEMORY', cb);
            conn.run('PRAGMA mmap_size = 268435456', cb);
        },
    },
});

async function initDatabase(): Promise<void> {
    await fs.mkdir('store', { recursive: true });

    const hasChatsTable = await knex.schema.hasTable('chats');
    if (!hasChatsTable) {
        await knex.schema.createTable('chats', (table) => {
            table.string('jid').primary();
            table.string('name');
            table.string('last_message_time').nullable();
            table.boolean('history_synced').defaultTo(false);
            table.string('last_sync_time').nullable();
        });
        console.log("Tabela 'chats' criada com sucesso.");
    } else {

        const hasHistorySynced = await knex.schema.hasColumn('chats', 'history_synced');
        if (!hasHistorySynced) {
            await knex.schema.alterTable('chats', (table) => {
                table.boolean('history_synced').defaultTo(false);
                table.string('last_sync_time').nullable();
            });
        }
    }

    const hasMessagesTable = await knex.schema.hasTable('messages');
    if (!hasMessagesTable) {
        await knex.schema.createTable('messages', (table) => {
            table.string('id').notNullable();
            table.string('chat_jid').notNullable();
            table.string('sender');
            table.text('content');
            table.string('timestamp').nullable();
            table.boolean('is_from_me');
            table.string('media_type');
            table.string('filename');
            table.string('local_path');
            table.string('media_url');
            table.binary('media_key');
            table.binary('media_file_hash');
            table.binary('media_file_enc_hash');
            table.integer('media_file_length');
            table.boolean('is_history').defaultTo(false);
            table.primary(['id', 'chat_jid']);
            table.foreign('chat_jid').references('jid').inTable('chats');


            table.index(['chat_jid', 'timestamp']);
            table.index(['timestamp']);
            table.index(['is_from_me']);
            table.index(['media_type']);
            table.index(['is_history']);
        });
        console.log("Tabela 'messages' criada com sucesso.");
    } else {

        const hasIsHistory = await knex.schema.hasColumn('messages', 'is_history');
        if (!hasIsHistory) {
            await knex.schema.alterTable('messages', (table) => {
                table.boolean('is_history').defaultTo(false);
                table.index(['is_history']);
            });
        }
    }


    const hasSyncStatusTable = await knex.schema.hasTable('sync_status');
    if (!hasSyncStatusTable) {
        await knex.schema.createTable('sync_status', (table) => {
            table.string('key').primary();
            table.text('value');
            table.string('updated_at');
        });
        console.log("Tabela 'sync_status' criada com sucesso.");
    }
}

async function storeChat(jid: string, name: string, lastMessageTime: string | null): Promise<void> {
    await knex('chats')
        .insert({ jid, name, last_message_time: lastMessageTime })
        .onConflict('jid')
        .merge(['name', 'last_message_time']);
}

async function storeMessage(messageData: StoredMessage, isHistory: boolean = false): Promise<void> {
    const dataWithHistory = { ...messageData, is_history: isHistory };
    await knex('messages')
        .insert(dataWithHistory)
        .onConflict(['id', 'chat_jid'])
        .merge();
}

async function batchStoreMessages(messages: StoredMessage[], isHistory: boolean = false): Promise<void> {
    if (messages.length === 0) return;

    const batchSize = 400;
    const messagesWithHistory = messages.map(msg => ({ ...msg, is_history: isHistory }));


    const promises: Promise<void>[] = [];

    for (let i = 0; i < messagesWithHistory.length; i += batchSize) {
        const batch = messagesWithHistory.slice(i, i + batchSize);



        const promise = knex('messages')
            .insert(batch)
            .onConflict(['id', 'chat_jid'])
            .merge()
            .then(() => { })
            .catch(async (error) => {
                console.warn(`Erro ao inserir lote de ${batch.length} mensagens:`, error);

                await Promise.all(
                    batch.map(msg =>
                        knex('messages')
                            .insert(msg)
                            .onConflict(['id', 'chat_jid'])
                            .merge()
                            .catch(() => { })
                    )
                );
                return;
            });

        promises.push(promise);


        if (promises.length >= 5) {
            await Promise.all(promises);
            promises.length = 0;
        }
    }


    if (promises.length > 0) {
        await Promise.all(promises);
    }
}

async function getMediaInfo(messageId: string, chatJID: string): Promise<StoredMessage | undefined> {
    return knex('messages')
        .where({ id: messageId, chat_jid: chatJID })
        .select('*')
        .first();
}


async function initializeClient(): Promise<void> {
    client = new WAWebJS.Client({
        authStrategy: new WAWebJS.LocalAuth({ dataPath: "store" }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ],
        },
    });

    client.on('qr', (qr: string) => {
        console.log('\nEscaneie este QR Code com seu app WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', async () => {
        console.log('\n✓ Conectado ao WhatsApp! Iniciando sincronização completa do histórico...');
        clientReadyTimestamp = new Date();


        setTimeout(async () => {
            console.log('🔄 Iniciando sincronização ULTRA RÁPIDA de histórico...');
            await performMassiveHistorySync();
        }, 1000);
    });

    client.on('disconnected', (reason: any) => {
        console.warn('Cliente foi desconectado!', reason);
        clientReadyTimestamp = null;
        historySyncComplete = false;
        totalHistoryMessages = 0;
        processedHistoryMessages = 0;

        setTimeout(() => {
            console.log('Tentando reconectar...');
            client.initialize().catch(err => console.error('Falha na reconexão:', err));
        }, 5000);
    });


    client.on('message', async (message: Message) => {
        if (!historySyncComplete) {
            console.log(`📥 Mensagem em tempo real ignorada durante sync: ${message.id._serialized}`);
            return;
        }

        if (!message.from || message.from === 'status@broadcast') return;


        const isNewMessage = clientReadyTimestamp && (message.timestamp * 1000) > clientReadyTimestamp.getTime();
        if (!isNewMessage) {
            console.log(`📜 Mensagem antiga ignorada: ${message.id._serialized}`);
            return;
        }

        try {
            await handleMessage(message, false);
            console.log(`✅ Nova mensagem processada: ${message.id._serialized}`);
        } catch (error) {
            console.error(`❌ Erro ao processar mensagem de ${message.from}:`, error);
        }
    });

    client.on('message_create', async (message: Message) => {
        if (message.fromMe && historySyncComplete) {
            await handleMessage(message, false);
        }
    });

    await client.initialize();
}


async function performMassiveHistorySync(): Promise<void> {
    try {
        const startTime = Date.now();
        console.log('📋 Obtendo lista de chats...');


        const chats = await client.getChats();
        console.log(`📊 Encontrados ${chats.length} chats para sincronização`);

        let totalMessages = 0;
        let totalChatsProcessed = 0;
        const allMessages: StoredMessage[] = [];
        const chatUpdates: Array<{ jid: string, name: string, timestamp: string }> = [];


        const concurrencyLimit = 15;

        for (let i = 0; i < chats.length; i += concurrencyLimit) {
            const chatBatch = chats.slice(i, i + concurrencyLimit);

            const batchPromises = chatBatch.map(async (chat) => {
                try {
                    const jid = chat.id._serialized;
                    const name = await getChatName(jid, chat);

                    console.log(`🔍 Processando chat: ${name} (${jid})`);



                    const allChatMessages: Message[] = [];
                    const maxAttempts = 20;
                    const parallelFetches = 3;


                    const initialPromises = Array.from({ length: parallelFetches }, (_, i) =>
                        chat.fetchMessages({ limit: 1000 }).catch(() => [])
                    );

                    const initialResults = await Promise.all(initialPromises);
                    const uniqueMessages = new Map<string, Message>();


                    for (const messages of initialResults) {
                        for (const msg of messages) {
                            uniqueMessages.set(msg.id._serialized, msg);
                        }
                    }

                    allChatMessages.push(...uniqueMessages.values());


                    let attempts = 0;
                    while (attempts < maxAttempts && allChatMessages.length < 10000) {
                        try {
                            const batchPromises = Array.from({ length: parallelFetches }, () =>
                                chat.fetchMessages({ limit: 1000 }).catch(() => [])
                            );

                            const batchResults = await Promise.all(batchPromises);
                            let newCount = 0;

                            for (const messages of batchResults) {
                                for (const msg of messages) {
                                    if (!uniqueMessages.has(msg.id._serialized)) {
                                        uniqueMessages.set(msg.id._serialized, msg);
                                        allChatMessages.push(msg);
                                        newCount++;
                                    }
                                }
                            }

                            if (newCount === 0) break;

                            console.log(`  📬 +${newCount} mensagens (total: ${allChatMessages.length})`);
                            attempts++;


                            await new Promise(resolve => setTimeout(resolve, 50));

                        } catch (fetchError) {
                            console.warn(`  ⚠️  Erro ao buscar mensagens do chat ${jid}:`, fetchError);
                            break;
                        }
                    }

                    if (allChatMessages.length === 0) return { messages: [], jid, name };


                    const validMessages: StoredMessage[] = [];
                    let latestTimestamp: string | null = null;


                    const chunkSize = 100;
                    const messageChunks = [];
                    for (let i = 0; i < allChatMessages.length; i += chunkSize) {
                        messageChunks.push(allChatMessages.slice(i, i + chunkSize));
                    }

                    const chunkPromises = messageChunks.map(async (chunk) => {
                        const chunkMessages: StoredMessage[] = [];

                        for (const msg of chunk) {
                            try {
                                const sender = msg.fromMe ? client.info.wid._serialized : (msg.author || msg.from);
                                const senderUser = sender.split('@')[0];
                                const timestamp = msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null;

                                if (!timestamp) continue;


                                if (!latestTimestamp || new Date(timestamp) > new Date(latestTimestamp)) {
                                    latestTimestamp = timestamp;
                                }

                                let content = msg.body || '';
                                let media_type: string | null = null;
                                let filename: string | null = null;


                                if (msg.hasMedia) {
                                    media_type = msg.type || 'unknown';
                                    const ext = getExtensionFromMimeType(media_type);
                                    filename = `${media_type}_${msg.timestamp}.${ext}`;
                                } else if (msg.type !== 'chat') {
                                    media_type = msg.type;
                                    content = content || `[${msg.type}]`;
                                }

                                const messageData: StoredMessage = {
                                    id: msg.id._serialized,
                                    chat_jid: jid,
                                    sender: senderUser,
                                    content,
                                    timestamp,
                                    is_from_me: msg.fromMe,
                                    media_type,
                                    filename,
                                    local_path: null,
                                    media_url: null,
                                    media_key: null,
                                    media_file_hash: null,
                                    media_file_enc_hash: null,
                                    media_file_length: null,
                                };

                                chunkMessages.push(messageData);

                            } catch (msgError) {

                            }
                        }

                        return chunkMessages;
                    });


                    const chunkResults = await Promise.all(chunkPromises);
                    chunkResults.forEach(chunk => validMessages.push(...chunk));


                    if (latestTimestamp) {
                        chatUpdates.push({ jid, name, timestamp: latestTimestamp });
                    }

                    console.log(`  ✅ Chat ${name}: ${validMessages.length} mensagens processadas`);

                    return { messages: validMessages, jid, name };

                } catch (chatError) {
                    console.error(`❌ Erro ao processar chat:`, chatError);
                    return { messages: [], jid: '', name: '' };
                }
            });


            const batchResults = await Promise.all(batchPromises);


            for (const result of batchResults) {
                if (result.messages.length > 0) {
                    allMessages.push(...result.messages);
                    totalMessages += result.messages.length;
                }
                totalChatsProcessed++;
            }


            const elapsed = (Date.now() - startTime) / 1000;
            const percentage = ((totalChatsProcessed / chats.length) * 100).toFixed(1);
            console.log(`📊 Progresso: ${totalChatsProcessed}/${chats.length} chats (${percentage}%) - ${totalMessages} mensagens - ${elapsed.toFixed(1)}s`);


            if (allMessages.length >= 2000) {
                console.log(`💾 Salvando lote de ${allMessages.length} mensagens...`);
                await batchStoreMessages(allMessages, true);
                allMessages.length = 0;
            }
        }


        if (allMessages.length > 0) {
            console.log(`💾 Salvando lote final de ${allMessages.length} mensagens...`);
            await batchStoreMessages(allMessages, true);
        }


        console.log(`💾 Atualizando informações de ${chatUpdates.length} chats...`);
        const chatUpdatePromises = chatUpdates.map(chatUpdate =>
            storeChat(chatUpdate.jid, chatUpdate.name, chatUpdate.timestamp)
                .catch(err => console.warn(`Erro ao atualizar chat ${chatUpdate.jid}:`, err))
        );
        await Promise.all(chatUpdatePromises);


        await knex('sync_status')
            .insert({
                key: 'last_full_sync',
                value: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .onConflict('key')
            .merge(['value', 'updated_at']);

        const totalTime = (Date.now() - startTime) / 1000;
        console.log(`\n🎉 SINCRONIZAÇÃO COMPLETA!`);
        console.log(`📊 Total: ${totalMessages} mensagens de ${totalChatsProcessed} chats`);
        console.log(`⏱️  Tempo: ${totalTime.toFixed(1)} segundos`);
        console.log(`⚡ Velocidade: ${(totalMessages / totalTime).toFixed(1)} mensagens/seg`);

        historySyncComplete = true;
        processedHistoryMessages = totalMessages;
        totalHistoryMessages = totalMessages;

        console.log('✅ API pronta para uso!');
        eventEmitter.emit('client:ready');

    } catch (error) {
        console.error('❌ Erro na sincronização massiva:', error);
        historySyncComplete = true;
        eventEmitter.emit('client:ready');
    }
}

function getExtensionFromMimeType(type: string): string {
    const extensions: { [key: string]: string } = {
        'image': 'jpg',
        'video': 'mp4',
        'audio': 'ogg',
        'document': 'pdf',
        'sticker': 'webp',
        'location': 'txt',
        'vcard': 'vcf',
        'ptt': 'ogg',
        'chat': 'txt'
    };
    return extensions[type] || 'bin';
}

async function handleMessage(message: Message, isHistory: boolean = false): Promise<void> {
    try {
        const chat: Chat = await message.getChat();
        const jid = chat.id._serialized;
        const name = await getChatName(jid, chat);
        const sender = message.fromMe ? client.info.wid._serialized : (message.author || message.from);
        const senderUser = sender.split('@')[0];
        const timestamp = message.timestamp ? new Date(message.timestamp * 1000).toISOString() : null;

        if (!timestamp) return;

        let content = message.body || '';
        let media_type: string | null = null;
        let filename: string | null = null;
        let local_path: string | null = null;
        let media_url: string | null = null;
        let media_key: Buffer | null = null;
        let media_file_hash: Buffer | null = null;
        let media_file_enc_hash: Buffer | null = null;
        let media_file_length: number | null = null;



        if (message.hasMedia && !isHistory) {
            const mediaMetadata = await extractMediaMetadata(message);
            media_type = mediaMetadata.media_type || null;
            filename = mediaMetadata.filename || null;
            local_path = mediaMetadata.local_path || null;
            media_url = mediaMetadata.media_url || null;
            media_key = mediaMetadata.media_key || null;
            media_file_hash = mediaMetadata.media_file_hash || null;
            media_file_enc_hash = mediaMetadata.media_file_enc_hash || null;
            media_file_length = mediaMetadata.media_file_length || null;
        } else if (message.hasMedia && isHistory) {

            media_type = message.type || 'unknown';
            const ext = getExtensionFromMimeType(media_type);
            filename = `${media_type}_${new Date(message.timestamp * 1000).toISOString().replace(/[-:T.]/g, '_')}.${ext}`;
        } else if (message.type !== 'chat') {
            media_type = message.type;
            content = content || `[${message.type}]`;
        }

        const messageData: StoredMessage = {
            id: message.id._serialized,
            chat_jid: jid,
            sender: senderUser,
            content,
            timestamp,
            is_from_me: message.fromMe,
            media_type,
            filename,
            local_path,
            media_url,
            media_key,
            media_file_hash,
            media_file_enc_hash,
            media_file_length,
        };

        await storeChat(jid, name, timestamp);
        await storeMessage(messageData, isHistory);


        const formattedTimestamp = timestamp.slice(0, 19).replace('T', ' ');
        const direction = message.fromMe ? '→' : '←';
        const historyFlag = isHistory ? '📜' : '🆕';
        const logContent = media_type && filename ? `[${media_type}: ${filename}] ${content || ''}`.trim() : content || `[${message.type}]`;

        if (!isHistory) {
            console.log(`${historyFlag} [${formattedTimestamp}] ${direction} ${senderUser}: ${logContent}`);
        }
    } catch (error) {
        console.error(`❌ Erro ao processar mensagem ${message.id._serialized}:`, error);
    }
}

async function extractMediaMetadata(message: Message): Promise<Partial<StoredMessage>> {
    try {
        const chat = await message.getChat();
        const media = await message.downloadMedia();
        if (!media) throw new Error('Falha ao baixar mídia');

        const media_type = media.mimetype.split('/')[0];
        const extension = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
        const filename = media.filename || `${media_type}_${new Date(message.timestamp * 1000).toISOString().replace(/[-:T.]/g, '_')}.${extension}`;
        const chatDir = path.join(__dirname, '..', '..', 'store', chat.id._serialized.replace(/@/g, '_'));
        await fs.mkdir(chatDir, { recursive: true });
        const local_path = path.join(chatDir, filename);
        const mediaData = Buffer.from(media.data, 'base64');
        await fs.writeFile(local_path, mediaData);

        const media_url = null;
        const media_file_length = mediaData.length;
        const media_file_hash = crypto.createHash('sha256').update(mediaData).digest();
        const media_file_enc_hash = media_file_hash;
        let media_key = crypto.randomBytes(32);

        if (media_type === 'audio' && extension === 'ogg') {
            const { duration, waveform } = await analyzeOggOpus(mediaData);
            media_key = waveform;
        }

        return {
            media_type,
            filename,
            local_path,
            media_url,
            media_key,
            media_file_hash,
            media_file_enc_hash,
            media_file_length,
        };
    } catch (error) {
        console.warn(`⚠️  Erro ao extrair metadados de mídia para ${message.id._serialized}:`, error);
        return {};
    }
}

async function analyzeOggOpus(data: Buffer): Promise<{ duration: number; waveform: Buffer }> {
    try {
        let duration = Math.ceil(data.length / 2000);
        duration = Math.max(1, Math.min(300, duration));
        const waveform = placeholderWaveform(duration);
        return { duration, waveform };
    } catch (err) {
        const duration = Math.max(1, Math.min(300, Math.ceil(data.length / 2000)));
        const waveform = placeholderWaveform(duration);
        return { duration, waveform };
    }
}

function placeholderWaveform(duration: number): Buffer {
    const waveformLength = 64;
    const waveform = Buffer.alloc(waveformLength);
    const baseAmplitude = 35.0;
    const frequencyFactor = Math.min(duration, 120) / 30.0;

    let seed = duration;
    for (let i = 0; i < 32; i++) {
        seed = (seed * 1103515245 + 12345) & 0xffffffff;
    }
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0xffffffff;
        return (seed / 0xffffffff) * 2 - 1;
    };

    for (let i = 0; i < waveformLength; i++) {
        const pos = i / waveformLength;
        let val = baseAmplitude * Math.sin(pos * Math.PI * frequencyFactor * 8);
        val += (baseAmplitude / 2) * Math.sin(pos * Math.PI * frequencyFactor * 16);
        val += rand() * 15;
        const fadeInOut = Math.sin(pos * Math.PI);
        val = val * (0.7 + 0.3 * fadeInOut) + 50;
        waveform[i] = Math.max(0, Math.min(100, Math.round(val)));
    }

    return waveform;
}

async function downloadMedia(messageId: string, chatJID: string): Promise<{ success: boolean; path?: string; filename?: string; error?: string }> {
    try {
        const mediaInfo = await getMediaInfo(messageId, chatJID);
        if (!mediaInfo) {
            return { success: false, error: "Mídia não encontrada no banco de dados." };
        }


        if (mediaInfo.local_path) {
            try {
                await fs.access(mediaInfo.local_path);
                return { success: true, path: mediaInfo.local_path, filename: mediaInfo.filename! };
            } catch {

            }
        }

        const chat = await client.getChatById(chatJID);
        const messages = await chat.fetchMessages({ limit: 100 });
        const targetMessage = messages.find(msg => msg.id._serialized === messageId);

        if (!targetMessage || !targetMessage.hasMedia) {
            return { success: false, error: "Mensagem ou mídia não encontrada." };
        }

        console.log(`📥 Iniciando download da mídia para a mensagem ${messageId}...`);
        const media = await targetMessage.downloadMedia();
        if (!media) {
            return { success: false, error: "Falha ao baixar a mídia do WhatsApp." };
        }

        const media_type = media.mimetype.split('/')[0];
        const extension = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
        const filename = media.filename || `${messageId}.${extension}`;
        const chatDir = path.join(__dirname, '..', '..', 'store', chatJID.replace(/@/g, '_'));
        await fs.mkdir(chatDir, { recursive: true });
        const localPath = path.join(chatDir, filename);
        const mediaData = Buffer.from(media.data, 'base64');
        await fs.writeFile(localPath, mediaData);


        await knex('messages')
            .where({ id: messageId, chat_jid: chatJID })
            .update({ local_path: localPath, filename, media_type });

        console.log(`✅ Mídia ${media_type} baixada e salva em: ${localPath}`);
        return { success: true, path: localPath, filename };
    } catch (error: any) {
        console.error('❌ Erro no download de mídia:', error);
        return { success: false, error: `Erro no download: ${error.message}` };
    }
}

async function sendWhatsAppMessage(recipient: string, message?: string, mediaPath?: string): Promise<{ success: boolean; message: string }> {
    if (!client || !client.info) {
        return { success: false, message: "O cliente do WhatsApp não está conectado." };
    }

    let recipientJID: string;
    if (recipient.includes('@')) {
        recipientJID = recipient;
    } else if (recipient.match(/^\d+$/)) {
        recipientJID = `${recipient}@c.us`;
    } else {
        return { success: false, message: `Destinatário inválido: '${recipient}'. Use um número ou JID (ex: '5511999999999@c.us').` };
    }

    try {
        let content: string | MessageMedia = message || '';
        const options: WAWebJS.MessageSendOptions = {};

        if (mediaPath) {
            const fileExists = await fs.stat(mediaPath).catch(() => false);
            if (!fileExists) {
                return { success: false, message: `Arquivo de mídia não encontrado em: ${mediaPath}` };
            }
            const mediaData = await fs.readFile(mediaPath);
            const mimeType = getMimeType(mediaPath);
            content = new MessageMedia(mimeType, mediaData.toString('base64'), path.basename(mediaPath));
            if (message) options.caption = message;
        }

        console.log(`📤 Enviando mensagem para ${recipientJID}...`);
        await client.sendMessage(recipientJID, content, options);
        console.log('✅ Mensagem enviada com sucesso.');
        return { success: true, message: `Mensagem enviada para ${recipient}` };
    } catch (error: any) {
        console.error('❌ Erro ao enviar mensagem:', error);
        return { success: false, message: `Erro ao enviar mensagem: ${error.message}` };
    }
}

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mimeTypes: { [key: string]: string } = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'ogg': 'audio/ogg; codecs=opus',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'mp4': 'video/mp4',
        'avi': 'video/avi',
        'mov': 'video/quicktime',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

async function getChatName(jid: string, chat?: Chat): Promise<string> {
    try {

        const existingName = await knex('chats').where({ jid }).select('name').first();
        if (existingName && existingName.name && existingName.name !== jid) {
            return existingName.name;
        }


        if (chat && (chat as GroupChat).isGroup) {
            const groupName = (chat as GroupChat).name || `Grupo ${chat.id._serialized}`;

            await knex('chats')
                .insert({ jid, name: groupName, last_message_time: null })
                .onConflict('jid')
                .merge(['name']);
            return groupName;
        }


        try {
            const contact = await client.getContactById(jid);
            const contactName = contact.name || contact.pushname || contact.number || jid;

            await knex('chats')
                .insert({ jid, name: contactName, last_message_time: null })
                .onConflict('jid')
                .merge(['name']);
            return contactName;
        } catch {
            return jid;
        }
    } catch {
        return jid;
    }
}


async function startRESTServer(port: number): Promise<void> {
    const app = express();
    app.use(express.json());


    app.post('/api/send', async (req: Request, res: Response<SendMessageResponse>) => {
        const { recipient, message } = req.body;

        const mediaPath = (req.body as any).mediaPath || (req.body as any).media_path;

        if (!recipient || (!message && !mediaPath)) {
            return res.status(400).json({
                success: false,
                message: 'Recipient e (message ou mediaPath) são obrigatórios.'
            });
        }

        const { success, message: responseMessage } = await sendWhatsAppMessage(recipient, message, mediaPath);

        if (success) {
            res.status(200).json({ success: true, message: responseMessage });
        } else {
            res.status(500).json({ success: false, message: responseMessage });
        }
    });


    app.post('/api/download', async (req: Request<{}, {}, DownloadMediaRequest>, res: Response<DownloadMediaResponse>) => {
        const { message_id, chat_jid } = req.body;

        if (!message_id || !chat_jid) {
            return res.status(400).json({
                success: false,
                message: 'message_id e chat_jid são obrigatórios.'
            });
        }

        const { success, path: localPath, filename, error } = await downloadMedia(message_id, chat_jid);

        if (success) {
            res.status(200).json({
                success: true,
                message: 'Caminho da mídia recuperado com sucesso.',
                filename,
                path: localPath,
            });
        } else {
            res.status(500).json({
                success: false,
                message: 'Erro ao buscar informações da mídia.',
                error
            });
        }
    });


    app.get('/api/status', async (req: Request, res: Response) => {
        try {
            const syncStatus = await knex('sync_status').where('key', 'last_full_sync').first();
            const totalChats = await knex('chats').count('jid as count').first();
            const totalMessages = await knex('messages').count('id as count').first();
            const totalHistoryMessages = await knex('messages').where('is_history', true).count('id as count').first();
            const totalRealtimeMessages = await knex('messages').where('is_history', false).count('id as count').first();

            res.json({
                client_ready: !!client?.info,
                history_sync_complete: historySyncComplete,
                last_sync: syncStatus?.value || null,
                stats: {
                    total_chats: totalChats?.count || 0,
                    total_messages: totalMessages?.count || 0,
                    history_messages: totalHistoryMessages?.count || 0,
                    realtime_messages: totalRealtimeMessages?.count || 0,
                },
                client_info: client?.info ? {
                    number: client.info.wid.user,
                    name: client.info.pushname,
                } : null
            });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao obter status' });
        }
    });


    app.get('/api/messages/:chatJid', async (req: Request, res: Response) => {
        try {
            const { chatJid } = req.params;
            const { limit = '50', offset = '0', search } = req.query;

            let query = knex('messages')
                .where('chat_jid', chatJid)
                .orderBy('timestamp', 'desc')
                .limit(parseInt(limit as string))
                .offset(parseInt(offset as string));

            if (search) {
                query = query.where('content', 'like', `%${search}%`);
            }

            const messages = await query;
            const chat = await knex('chats').where('jid', chatJid).first();

            res.json({
                chat: chat || null,
                messages,
                total: messages.length
            });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao buscar mensagens' });
        }
    });


    app.get('/api/chats', async (req: Request, res: Response) => {
        try {
            const { limit = '100', search } = req.query;

            let query = knex('chats')
                .orderBy('last_message_time', 'desc')
                .limit(parseInt(limit as string));

            if (search) {
                query = query.where('name', 'like', `%${search}%`);
            }

            const chats = await query;


            const chatsWithStats = await Promise.all(
                chats.map(async (chat) => {
                    const messageCount = await knex('messages')
                        .where('chat_jid', chat.jid)
                        .count('id as count')
                        .first();

                    return {
                        ...chat,
                        message_count: messageCount?.count || 0
                    };
                })
            );

            res.json({
                chats: chatsWithStats,
                total: chatsWithStats.length
            });
        } catch (error) {
            res.status(500).json({ error: 'Erro ao buscar chats' });
        }
    });

    app.listen(port, () => {
        console.log(`🚀 Servidor da API REST rodando em http://localhost:${port}`);
        console.log(`📊 Status: http://localhost:${port}/api/status`);
        console.log(`💬 Chats: http://localhost:${port}/api/chats`);
    });
}


async function main(): Promise<void> {
    console.log("🔧 Inicializando banco de dados...");
    await initDatabase();

    console.log("📱 Inicializando cliente do WhatsApp...");
    await initializeClient();


    eventEmitter.on('client:ready', () => {
        startRESTServer(8080).catch(err => console.error('❌ Erro ao iniciar o servidor REST:', err));
    });
}


process.on('SIGINT', async () => {
    console.log('\n🛑 Recebido sinal de interrupção. Desconectando...');
    if (client) {
        await client.destroy();
    }
    await knex.destroy();
    console.log('✅ Cliente desconectado. Encerrando processo.');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Recebido sinal de término. Desconectando...');
    if (client) {
        await client.destroy();
    }
    await knex.destroy();
    console.log('✅ Cliente desconectado. Encerrando processo.');
    process.exit(0);
});


process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Rejeição não tratada em:', promise, 'razão:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Exceção não capturada:', error);
    process.exit(1);
});


main().catch(err => {
    console.error("💥 Falha fatal na inicialização:", err);
    process.exit(1);
});