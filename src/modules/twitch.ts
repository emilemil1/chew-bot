import { CommandModule, ModuleType, BotUtils, PersistenceData, WebhookModule, WebhookMessage, WebhookResponse } from "discord-dbm";
import { Message, TextChannel, MessageEmbed, Guild as DGuild } from "discord.js";
import dedent from "dedent";
import fetch, { RequestInit, Response } from "node-fetch";

interface TwitchChannelNames {
    [key: string]: null;
}

interface Live {
    chat: string;
    message: string;
    notify: boolean;
}

interface LiveChannel {
    date: Date;
    title: string;
    name: string;
    guilds: string[];
}

interface Guild {
    chat?: string;
    live?: Live;
    channels: TwitchChannelNames;
}

interface Guilds {
    [key: string]: Guild;
}

interface GuildIds {
    [key: string]: null;
}

interface TwitchChannel {
    guildIds: GuildIds;
    count: number;
    id: string;
}

interface TwitchChannels {
    [key: string]: TwitchChannel;
}

interface Persistence {
    guilds: Guilds;
    channels: TwitchChannels;
}

interface TwitchChannelInfo {
    id: string;
    name: string;
    displayName: string;
    error?: string;
}

interface Params {
    [key: string]: string;
}

interface RemoteFollows {
    expiresAt: string;
    id: string;
}

class Twitch implements CommandModule, WebhookModule {
    configuration = {
        name: "Twitch Notifier",
        description: "",
        type: [ModuleType.command, ModuleType.webhook],
        commands: ["twitch"],
        webhook: ["/twitch"]
    }
    data: Persistence = {
        guilds: {},
        channels: {}
    }
    clientId = "";
    clientSecret = "";
    token = "";
    activeChannels: Map<string, LiveChannel> = new Map();
    dupe = new Set();

    async onLoad(): Promise<void> {
        this.clientId = BotUtils.getValue("twitchId");
        this.clientSecret = BotUtils.getValue("twitchSecret");
        await this.authorize();
        setInterval(() => this.renewFollows(), 3600000);
        const data = await BotUtils.storage?.get("twitch");
        if (data !== undefined) this.data = data as unknown as Persistence;

        const follows = (await this.getFollows()).map(f => f.id).map(f => "user_id="+f);
        const options = (): RequestInit => {
            return {
                headers: {
                    "Client-ID": this.clientId,
                    "Authorization": "Bearer " + this.token
                },
            };
        };
        for (let index = 0; index <= follows.length; index+=100) {
            const json = await (await this.call(`https://api.twitch.tv/helix/streams?first=100&${follows.join("&")}`, options)).json();
            for (const stream of json.data) {
                if (this.data.channels[stream["user_name"].toLowerCase()] === undefined) continue;
                const activeChannel: LiveChannel = {
                    date: new Date(stream.started_at),
                    title: stream.title,
                    name: stream.user_name,
                    guilds: Object.getOwnPropertyNames(this.data.channels[stream["user_name"].toLowerCase()].guildIds)
                };
                this.activeChannels.set(stream.user_id, activeChannel);
            }
        }
    }

    async onShutdown(): Promise<void> {
        await BotUtils.storage?.set("twitch", this.data as unknown as PersistenceData);
    }
    
    async onCommand(command: string[], message: Message): Promise<void> {
        if (command.length === 1) {
            this.help(message);
            return;
        }
        if (command.length === 2 && command[1] === "here") {
            this.here(message);
            return;
        }
        if (command.length === 2 && command[1] === "list") {
            this.list(message);
            return;
        }
        if (command.length === 2 && command[1] === "live") {
            await this.live(message);
            return;
        }
        if (command.length === 2) {
            await this.info(command[1].toLowerCase(), message);
            return;
        }
        if (command.length === 3 && command[1] === "follow") {
            await this.follow(command[2].toLowerCase(), message);
            return;
        }

        if (command.length === 3 && command[1] === "live" && command[2] == "notify") {
            this.livenotify(message);
            return;
        }
        if (command.length === 3 && command[1] === "unfollow") {
            await this.unfollow(command[2].toLowerCase(), message);
            return;
        }
    }

    async hook(message: WebhookMessage): Promise<WebhookResponse> {
        console.log(message);
        if (message.body === "") {
            const index = message.webhook.indexOf("hub.challenge=");
            return {
                code: 200,
                body: message.webhook.substring(index+14, message.webhook.indexOf("&", index))
            };
        }

        const json = JSON.parse(message.body);

        if (json.data.length === 0) {
            const index = message.headers.link.indexOf("user_id=")+8;
            const id = message.headers.link.substring(index, message.headers.link.indexOf(">", index));
            this.setLiveChannelOffline(id);

            return {
                code: 200,
                body: "Ok"
            };
        }

        if (this.data.channels[json.data[0].user_name?.toLowerCase()] === undefined) {
            return {
                code: 200,
                body: "Ok"
            };
        }

        const update = this.activeChannels.has(json.data[0].user_id) || this.dupe.has(json.data[0].user_id);

        const activeChannel: LiveChannel = {
            date: new Date(json.data[0].started_at),
            title: json.data[0].title,
            name: json.data[0].user_name,
            guilds: []
        };

        this.dupe.add(json.data[0].user_id);
        setTimeout(() => this.dupe.delete(json.data[0].user_id), 900000);

        this.activeChannels.set(json.data[0].user_id, activeChannel);

        for (const guildId in this.data.channels[json.data[0].user_name.toLowerCase()].guildIds) {
            const guild = this.data.guilds[guildId];
            if (guild.chat !== undefined && !update) {
                const chat = BotUtils.getDiscordClient().guilds.cache.get(guildId)?.channels.cache.get(guild.chat) as TextChannel;
                chat.send(
                    dedent`
                    https://twitch.tv/${json.data[0].user_name} is now live!
                    Streaming: ${json.data[0].title}
                    `
                );
            }
            if (guild.live !== undefined) {
                (BotUtils.getDiscordClient().guilds.cache.get(guildId)?.channels.cache.get(guild.live.chat) as TextChannel).messages.fetch(guild.live.message)
                    .then(msg => {
                        if (msg.embeds.length === 0) {
                            delete guild.live;
                            return;
                        }
                        activeChannel.guilds.push(guildId);
                        const embed = msg?.embeds[0];
                        if (embed === undefined) return;
                        let index = 0;
                        for (const field of embed.fields) {
                            if (field.name === `https://twitch.tv/${activeChannel.name}`) {
                                if (update) {
                                    field.value = "Streaming: " + activeChannel.title;
                                } else {
                                    embed.fields.splice(index);
                                }
                                index++;
                                break;
                            }
                        }
                        if (!update) {
                            embed.addField(`https://twitch.tv/${activeChannel.name}`, "Streaming: " + activeChannel.title);
                            embed.setDescription("");
                            
                            if (guild.live?.notify === true) {
                                msg.channel.send(`${activeChannel.name} is now live!`)
                                    .then(msg => msg.delete());
                            }
                        }
                        msg?.edit(embed);
                    })
                    .catch(() => delete guild.live);
            }
        }

        return {
            code: 200,
            body: "Ok"
        };
    }

    getTime(date: Date): string {
        const timeString = date.toTimeString();
        return timeString.substring(0, timeString.indexOf(" "));
    }

    help(message: Message): void {
        message.channel.send(
            dedent`
            \`\`\`
            Commands:
                ${BotUtils.getPrefix(message.guild?.id)}twitch [channel]
                    - display channel info
                ${BotUtils.getPrefix(message.guild?.id)}twitch follow/unfollow [channel]
                    - toggle channel notifications
                ${BotUtils.getPrefix(message.guild?.id)}twitch list
                    - show all followed channels
                ${BotUtils.getPrefix(message.guild?.id)}twitch here
                    - toggle notification chatroom
                ${BotUtils.getPrefix(message.guild?.id)}twitch live
                    - display an auto-updating live channel list
                ${BotUtils.getPrefix(message.guild?.id)}twitch live notify
                    - toggle notifications on live channel list updates
            \`\`\`
            `.trim()
        );
    }

    list(message: Message): void {
        if (message.guild == null) return;
        const channels = this.data.guilds[message.guild.id]?.channels;
        if (channels === undefined) {
            message.channel.send("You are not following any Twitch channels.");
            return;
        }

        const channelNames = Object.getOwnPropertyNames(channels).sort().join("\n");

        message.channel.send(
            dedent`
            You are following these Twitch channels:
            \`\`\`
            ${channelNames}
            \`\`\`
            `.trim()
        );
    }

    async live(message: Message): Promise<void> {
        if (message.guild == null) return;
        let guild = this.data.guilds[message.guild.id];
        if (guild === undefined) {
            guild = {
                channels: {}
            };
            this.data.guilds[message.guild.id] = guild;
        }

        const updateoldlivepost = async (remoteguild: DGuild | null, localguild: Guild, post?: string): Promise<void> => {
            if (remoteguild === null || localguild.live === undefined || post === undefined) return;
            const msg = await (remoteguild.channels.cache.get(localguild.live.chat) as TextChannel).messages.fetch(post)
                .catch(() => undefined);
            const embed = msg?.embeds[0];
            if (embed === undefined) return;
            msg?.edit(embed?.setFooter("Offline - This post is no longer being updated"));
        };
        

        if (guild.live !== undefined) {
            updateoldlivepost(message.guild, guild, guild.live.message);
        }

        const embed = new MessageEmbed()
            .setColor("#9344fb")
            .setAuthor("Live Channels", "https://cdn.discordapp.com/app-icons/710193225905995796/58574a723796ec1b95526b8d01e0e461.png?size=256")
            .setFooter("Online - This post is being updated live!");

        for (const livechannel of this.activeChannels.values()) {
            if (guild.channels[livechannel.name.toLowerCase()] !== undefined) {
                embed.addField(`https://twitch.tv/${livechannel.name}`, "Streaming: " + livechannel.title);
                if (guild.live === undefined) {
                    livechannel.guilds.push(message.guild.id);
                }
            }
        }

        if (embed.fields.length === 0) {
            embed.setDescription("*It seems no one is streaming at the moment...*");
        }

        const response = await message.channel.send(embed);

        guild.live = {
            chat: message.channel.id,
            message: response.id,
            notify: false
        };
    }

    livenotify(message: Message): void {
        if (message.guild == null) return;
        const guild = this.data.guilds[message.guild.id];
        if (guild === undefined || guild.live === undefined) {
            message.channel.send(`Please first set up live updates. The command is '${BotUtils.getPrefix(message.guild.id)}twitch live'.`);
            return;
        }

        if (guild.live.notify === true) {
            message.channel.send("The Live Channels post will no longer notify when channels go live.");
            guild.live.notify = false;
        } else {
            message.channel.send("The Live Channels post will notify when channels go live.");
            guild.live.notify = true;
        }
    }

    async setLiveChannelOffline (channelId: string): Promise<void> {
        const liveChannel = this.activeChannels.get(channelId);
        if (liveChannel === undefined) return;

        this.activeChannels.delete(channelId);

        for (const guildId of liveChannel.guilds) {
            //TODO
            const localguild = this.data.guilds[guildId];
            const remoteguild = BotUtils.getDiscordClient().guilds.cache.get(guildId);
            if (remoteguild === null || remoteguild === undefined || localguild.live === undefined) return;
            (remoteguild.channels.cache.get(localguild.live.chat) as TextChannel).messages.fetch(localguild.live.message)
                .then(msg => {
                    const embed = msg?.embeds[0];
                    if (embed === undefined) return;
                    let index = 0;
                    for (const field of embed.fields) {
                        if (field.name === `https://twitch.tv/${liveChannel.name}`) {
                            embed.fields.splice(index);
                            break;
                        }
                        index++;
                    }
                    if (embed.fields.length === 0) {
                        embed.setDescription("*It seems no one is streaming at the moment...*");
                    }
                    msg?.edit(embed);
                })
                .catch(() => delete localguild.live);
        }
    }

    async info(channel: string, message: Message): Promise<void> {
        if (message.guild == null) return;
        const channelInfo = await this.searchChannel(channel);
        if (channelInfo?.error !== undefined) {
            message.channel.send(channelInfo.error);
            return;
        }
        if (channel !== channelInfo.name) {
            message.channel.send("The channel could not be found. Did you mean this one?");
        }
        const notificationsEnabled = this.data.guilds[message.guild.id]?.channels[channel] !== undefined;
        message.channel.send(`https://twitch.tv/${channelInfo.name}${notificationsEnabled ? " (notifications enabled)" : ""}`);
    }

    async follow(channel: string, message: Message): Promise<void> {
        if (message.guild == null) return;
        const guild = this.data.guilds[message.guild.id];
        if (guild === undefined || guild.chat === undefined) {
            message.channel.send(`Please first assign a chat to notify in. The command is '${BotUtils.getPrefix(message.guild.id)}twitch here'.`);
            return;
        }

        if (guild.channels[channel] !== undefined) {
            message.channel.send("Notifications are already active for this channel.");
            return;
        }

        const channelInfo = await this.getChannelInfo(channel);
        if (channelInfo?.error !== undefined) {
            message.channel.send(channelInfo.error);
            return;
        }

        guild.channels[channel] = null;
        if (this.data.channels[channel] === undefined) {
            this.data.channels[channel] = {
                guildIds: {},
                count: 0,
                id: channelInfo.id
            };
            await this.subscribe(channelInfo.id, true);
        }
        this.data.channels[channel].guildIds[message.guild.id] = null;
        this.data.channels[channel].count++;
        message.channel.send("Notifications enabled for Twitch channel: " + channelInfo.displayName);
        return;
    }

    async unfollow(channel: string, message: Message): Promise<void> {
        if (message.guild == null) return;
        const guild = this.data.guilds[message.guild.id];
        if (guild.channels[channel] === undefined) {
            message.channel.send("Notifications are not active for this channel.");
            return;
        }

        const channelInfo = await this.getChannelInfo(channel);
        if (channelInfo?.error !== undefined) {
            message.channel.send(channelInfo.error);
            return;
        }

        delete guild.channels[channel];
        delete this.data.channels[channel].guildIds[message.guild.id];
        this.data.channels[channel].count--;
        if (this.data.channels[channel].count === 0) {
            delete this.data.channels[channel];
            await this.subscribe(channelInfo.id, false);
        }
        message.channel.send("Notifications disabled for Twitch channel: " + channelInfo.displayName);
    }

    async searchChannel(channel: string): Promise<TwitchChannelInfo> {

        const options = (): RequestInit => {
            return {
                headers: {
                    "Accept": "application/vnd.twitchtv.v5+json",
                    "Client-ID": this.clientId,
                    "Authorization": "Bearer " + this.token
                }
            };
        };
        const result = await (await this.call(`https://api.twitch.tv/kraken/search/channels?query=${channel}&limit=1`, options)).json();
        if (result.error !== undefined) {
            return {
                id: "",
                name: channel,
                displayName: "",
                error: "Could not retrieve data from Twitch, try again later."
            };
        }

        if (result.channels.length === 0) {
            return {
                id: "",
                name: channel,
                displayName: "",
                error: "Could not find a matching channel."
            };
        }

        return {
            id: result.channels[0].id,
            name: result.channels[0].name,
            displayName: result.channels[0].display_name,
        };
    }

    async getChannelInfo(channel: string): Promise<TwitchChannelInfo> {
        const options = (): RequestInit => {
            return {
                headers: {
                    "Client-ID": this.clientId,
                    "Authorization": "Bearer " + this.token
                }
            };
        };
        const result = await (await this.call(`https://api.twitch.tv/helix/users?login=${channel.toLowerCase()}`, options)).json();
        if (result.error !== undefined) {
            return {
                id: "",
                name: channel,
                displayName: "",
                error: "Could not retrieve data from Twitch, try again later."
            };
        }

        if (result.data.length === 0) {
            return {
                id: "",
                name: channel,
                displayName: "",
                error: "This channel does not exist."
            };
        }

        return {
            id: result.data[0].id,
            name: channel,
            displayName: result.data[0].display_name
        };
    }

    here(message: Message): void {
        if (message.guild == null) return;
        let guild = this.data.guilds[message.guild.id];
        if (guild === undefined) {
            guild = {
                channels: {}
            };
            this.data.guilds[message.guild.id] = guild;
        }
        if (guild.chat !== message.channel.id) {
            guild.chat = message.channel.id;
            message.channel.send("Twitch notifications will now appear in this chat!");
        } else {
            delete guild.chat;
            message.channel.send("Twitch notifications will no longer appear.");
        }

        return;
    }

    async subscribe(id: string, subscribe: boolean): Promise<string|undefined> {
        const url = BotUtils.getValue("url");
        const port = BotUtils.getValue("webhookPort");
        const options = (): RequestInit => {
            return {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Client-ID": this.clientId,
                    "Authorization": "Bearer " + this.token
                },
                body: JSON.stringify(
                    {
                        "hub.callback": `https://${url}:${port}/webhook/twitch`,
                        "hub.mode": subscribe ? "subscribe" : "unsubscribe",
                        "hub.topic": "https://api.twitch.tv/helix/streams?user_id=" + id,
                        "hub.lease_seconds": "864000"
                    }
                ) 
            };
        };
        const result = await this.call("https://api.twitch.tv/helix/webhooks/hub", options);
        if (!result.ok) {
            return "Could not send data to Twitch, try again later.";
        }
    }

    async renewFollows(): Promise<void> {
        const follows = await this.getFollows();
        this.cleanFollows(follows.map(fol => fol.id));
        const date = new Date();
        date.setDate(date.getDate()+1);
        const ids = new Set(Object.getOwnPropertyNames(this.data.channels).map(name => this.data.channels[name].id));

        for (const entry of follows) {
            if (date > new Date(entry.expiresAt) && ids.has(entry.id)) {
                this.subscribe(entry.id, true);
            }
        }
    }

    async cleanFollows(keepFollows: string[]): Promise<void> {
        const keepFollowsSet = new Set(keepFollows);
        const removeCandidates: string[] = [];
        for (const channel in this.data.channels) {
            if (!keepFollowsSet.has(this.data.channels[channel].id)) {
                removeCandidates.push(channel);
            }
        }

        for (const channel in removeCandidates) {
            delete this.data.channels[channel];
            for (const guild in this.data.guilds) {
                delete this.data.guilds[guild].channels[channel];
            }
        }
    }

    async getFollows(): Promise<RemoteFollows[]> {
        const options = (): RequestInit => {
            return {
                headers: {
                    "Client-ID": this.clientId,
                    "Authorization": "Bearer " + this.token
                }
            };
        };
        let page;
        let result;
        const data = [];
        do {
            result = await (await this.call(`https://api.twitch.tv/helix/webhooks/subscriptions?first=100${page !== undefined ? "&after="+page : ""}`, options)).json();
            page = result.pagination.cursor;
            data.push(...result.data);
        } while (page !== undefined);

        return data.map(entry => {
            return {
                id: entry.topic.substring(entry.topic.lastIndexOf("=")+1),
                expiresAt: entry.expires_at
            };
        });
             
    }

    async call(url: string, options: () => RequestInit, scopes?: string[], retry = true): Promise<Response> {
        const result = await fetch(url, options());
        if (result.ok || retry === false) {
            return result;
        }
        if (result.status === 401 || result.status === 402 || result.status === 403) {
            return this.authorize().then(() => this.call(url, options, scopes, retry = false));
        }
        return result;
    }

    async authorize(scopes = []): Promise<string> {
        const options: RequestInit = {
            method: "POST"
        };
        const url = new URL("https://id.twitch.tv/oauth2/token");
        const params: Params = {
            "client_id": BotUtils.getValue("twitchId"),
            "client_secret": BotUtils.getValue("twitchSecret"),
            "grant_type": "client_credentials",
        };
        if (scopes.length !== 0) params["scope"] = scopes.join(" ");
        Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
        const result = await (await fetch(url, options)).json();
        this.token = result.access_token;
        return result.access_token;
    }
}

export default new Twitch();