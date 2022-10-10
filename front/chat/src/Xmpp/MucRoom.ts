import type { ChatConnection } from "../Connection/ChatConnection";
import xml, { Element } from "@xmpp/xml";
import jid, { JID } from "@xmpp/jid";
import type { Readable, Writable } from "svelte/store";
import { get, writable } from "svelte/store";
import ElementExt from "./Lib/ElementExt";
import { mucRoomsStore, numberPresenceUserStore } from "../Stores/MucRoomsStore";
import { v4 as uuidv4 } from "uuid";
import { userStore } from "../Stores/LocalUserStore";
import { UserData } from "../Messages/JsonMessages/ChatData";
import { filesUploadStore, mentionsUserStore } from "../Stores/ChatStore";
import { fileMessageManager } from "../Services/FileMessageManager";
import { mediaManager, NotificationType } from "../Media/MediaManager";
import { availabilityStatusStore } from "../Stores/ChatStore";
import { activeThreadStore } from "../Stores/ActiveThreadStore";
import Timeout = NodeJS.Timeout;
import { connectionManager } from "../Connection/ChatConnectionManager";
import {
    AbstractRoom,
    ChatStates,
    defaultUser,
    defaultUserData,
    defaultWoka,
    Message, MessageType,
    ReactAction,
    ReactMessage,
    ReplyMessage,
    User,
    UserStatus,
    UserList,
    UsersStore
} from "./AbstractRoom";
import {HtmlUtils} from "../Utils/HtmlUtils";
import {XmppClient} from "./XmppClient";

export type Teleport = {
    state: boolean;
    to: string | null;
};
export type TeleportStore = Readable<Teleport>;

export type Me = {
    isAdmin: boolean;
};

export type MeStore = Readable<Me>;

const _VERBOSE = true;

export class MucRoom extends AbstractRoom{
    private presenceStore: Writable<UserList>;
    private teleportStore: Writable<Teleport>;
    private meStore: Writable<Me>;
    private composingTimeOut: Timeout | undefined;
    private sendTimeOut: Timeout | undefined;
    private canLoadOlderMessagesStore: Writable<boolean>;
    private showDisabledLoadOlderMessagesStore: Writable<boolean>;
    private closed: boolean = false;
    private description: string = "";
    private maxHistoryDate: string = "";
    private getAllSubscriptionsId: string = "";
    private loadingSubscribers: Writable<boolean>;
    private readyStore: Writable<boolean>;
    private presenceId: string = "";
    private subscriptions = new Map<string, string>();

    constructor(
        protected connection: ChatConnection,
        xmppClient: XmppClient,
        public readonly name: string,
        protected roomJid: jid.JID,
        public type: string,
        public subscribe: boolean,
        private jid: string
    ) {
        super(connection, xmppClient);

        this.presenceStore = writable<UserList>(new Map<string, User>());
        this.teleportStore = writable<Teleport>({ state: false, to: null });
        this.meStore = writable<Me>({ isAdmin: false });
        this.canLoadOlderMessagesStore = writable<boolean>(true);
        this.showDisabledLoadOlderMessagesStore = writable<boolean>(false);
        this.loadingSubscribers = writable<boolean>(false);
        this.readyStore = writable<boolean>(true);
    }

    public getPlayerName() {
        try {
            return connectionManager.connectionOrFail.getXmppClient()?.getPlayerName() ?? "unknown";
        } catch (e) {
            console.log(e);
        }
        return "unknown";
    }

    public getPlayerUuid() {
        return get(userStore).uuid ?? "unknown";
    }

    public getUserDataByName(name: string) {
        let woka = defaultWoka;
        let color = "";
        let jid = null;
        if (this.getPlayerName() === name) {
            woka = get(userStore).woka;
            color = get(userStore).color;
        } else {
            get(this.presenceStore).forEach((user, jid_) => {
                if (user.name === name) {
                    woka = user.woka;
                    color = user.color;
                    jid = jid_;
                }
            });
        }
        return { woka, color, jid };
    }

    public getUserDataByUuid(uuid: string): UserData {
        for (const [, user] of get(this.presenceStore)) {
            if (user.uuid === uuid) {
                return user as unknown as UserData;
            }
        }
        return defaultUserData;
    }

    protected getUser(jid: JID | string): User {
        return get(this.presenceStore).get(jid.toString()) ?? defaultUser;
    }

    public goTo(type: string, playUri: string, uuid: string) {
        this.teleportStore.set({ state: true, to: uuid });
        if (type === "room") {
            window.parent.postMessage({ type: "goToPage", data: { url: `${playUri}#moveToUser=${uuid}` } }, "*");
        } else if (type === "user") {
            window.parent.postMessage({ type: "askPosition", data: { uuid, playUri } }, "*");
        }
    }

    public connect() {
        if (userStore.get().isLogged && this.subscribe && this.type !== "live") {
            this.sendSubscribe();
        } else {
            this.sendPresence(true);
        }
    }

    private sendRequestAllSubscribers() {
        const uuid = uuidv4();
        const messageMucListAllUsers = xml(
            "iq",
            {
                type: "get",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: uuid,
            },
            xml("subscriptions", {
                xmlns: "urn:xmpp:mucsub:0",
            })
        );
        if (!this.closed) {
            this.loadingSubscribers.set(true);
            this.getAllSubscriptionsId = uuid;
            this.connection.emitXmlMessage(messageMucListAllUsers);
            if (_VERBOSE) console.warn("[XMPP]", ">> Get all subscribers sent");
        }
    }
    public sendRetrieveLastMessages() {
        const firstMessage = get(this.messageStore).shift();
        this.loadingStore.set(true);
        const now = new Date();
        const messageRetrieveLastMessages = xml(
            "iq",
            {
                type: "set",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: uuidv4(),
            },
            xml(
                "query",
                {
                    xmlns: "urn:xmpp:mam:2",
                },
                xml(
                    "x",
                    {
                        xmlns: "jabber:x:data",
                        type: "submit",
                    },
                    xml(
                        "field",
                        {
                            var: "FORM_TYPE",
                            type: "hidden",
                        },
                        xml("value", {}, "urn:xmpp:mam:2")
                    ),
                    xml(
                        "field",
                        {
                            var: "end",
                        },
                        xml("value", {}, firstMessage ? firstMessage.time.toISOString() : now.toISOString())
                    )
                ),
                xml(
                    "set",
                    {
                        xmlns: "http://jabber.org/protocol/rsm",
                    },
                    xml("max", {}, "50")
                )
            )
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messageRetrieveLastMessages);
            if (_VERBOSE) console.warn("[XMPP]", ">> Get older messages sent");
        }
    }
    public sendPresence(first: boolean = false) {
        const presenceId = uuidv4();
        if (first) {
            this.presenceId = presenceId;
        }
        const messagePresence = xml(
            "presence",
            {
                to: jid(this.roomJid.local, this.roomJid.domain, this.getPlayerName()).toString(),
                from: this.jid,
                id: presenceId,
                //type:'subscribe', //check presence documentation https://www.ietf.org/archive/id/draft-ietf-xmpp-3921bis-01.html#sub
                //persistent: true
            },
            xml("x", {
                xmlns: "http://jabber.org/protocol/muc#user",
            }),
            // Add window location and have possibility to teleport on the user and remove all hash from the url
            xml("room", {
                playUri: get(userStore).playUri,
                name: get(userStore).roomName,
            }),
            // Add uuid of the user to identify and target them on teleport
            xml("user", {
                uuid: get(userStore).uuid,
                color: get(userStore).color,
                woka: get(userStore).woka,
                // If you can subscribe to the default muc room, this is that you are a member
                isMember: mucRoomsStore.getDefaultRoom()?.subscribe ?? false,
                availabilityStatus: get(availabilityStatusStore),
                visitCardUrl: get(userStore).visitCardUrl,
            })
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messagePresence);
            if (_VERBOSE) console.warn("[XMPP]", ">> ", first && "First", "Presence sent", get(userStore).uuid);
        }
    }
    private sendSubscribe() {
        const messageMucSubscribe = xml(
            "iq",
            {
                type: "set",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: uuidv4(),
            },
            xml(
                "subscribe",
                {
                    xmlns: "urn:xmpp:mucsub:0",
                    nick: this.getPlayerName(),
                },
                xml("event", { node: "urn:xmpp:mucsub:nodes:subscribers" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:messages" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:config" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:presence" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:affiliations" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:system" }),
                xml("event", { node: "urn:xmpp:mucsub:nodes:subject" })
            )
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messageMucSubscribe);
            if (_VERBOSE)
                console.warn("[XMPP]", ">> Subscribe sent from", this.getPlayerName(), "to", this.roomJid.local);
        }
    }
    public sendRankUp(userJID: string | JID) {
        this.sendAffiliate("admin", userJID);
    }
    public sendRankDown(userJID: string | JID) {
        this.sendAffiliate("none", userJID);
    }
    private sendAffiliate(type: string, userJID: string | JID) {
        const messageMucAffiliateUser = xml(
            "iq",
            {
                type: "set",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: uuidv4(),
            },
            xml(
                "query",
                {
                    xmlns: "http://jabber.org/protocol/muc#admin",
                },
                xml(
                    "item",
                    {
                        affiliation: type,
                        jid: userJID.toString(),
                    },
                    xml("reason", {}, "test")
                )
            )
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messageMucAffiliateUser);
            if (_VERBOSE) console.warn("[XMPP]", ">> Affiliation sent");
        }
    }
    public sendBan(user: string, name: string, playUri: string) {
        const userJID = jid(user);
        //this.affiliate("outcast", userJID);
        this.connection.emitBanUserByUuid(playUri, userJID.local, name, "Test message de ban");
        if (_VERBOSE) console.warn("[XMPP]", ">> Ban user message sent");
    }

    public reInitialize() {
        // Destroy room in ejabberd
        this.sendDestroy();
        // Recreate room in ejabberd
        //setTimeout(() => this.sendPresence(), 100);
        // Tell all users to subscribe to it
        //setTimeout(() => this.connection.emitJoinMucRoom(this.name, this.type, this.roomJid.local), 200);
    }

    public sendDestroy() {
        const destroyId = uuidv4();
        const messageMucDestroy = xml(
            "iq",
            {
                type: "set",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: destroyId,
            },
            xml(
                "query",
                {
                    xmlns: "http://jabber.org/protocol/muc#owner",
                },
                xml(
                    "destroy",
                    {
                        jid: jid(this.roomJid.local, this.roomJid.domain).toString(),
                    },
                    xml("reason", {}, "")
                )
            )
        );
        if (!this.closed) {
            this.subscriptions.set(destroyId, "destroyRoom");
            this.connection.emitXmlMessage(messageMucDestroy);
            if (_VERBOSE) console.warn("[XMPP]", ">> Destroy room sent");
        }
    }

    public sendDisconnect() {
        const presenceId = uuidv4();
        this.presenceId = presenceId;
        const to = jid(this.roomJid.local, this.roomJid.domain, this.getPlayerName());
        const messageMucSubscribe = xml(
            "presence",
            { to: to.toString(), from: this.jid, type: "unavailable", id: presenceId },
            xml("x", { xmlns: "http://jabber.org/protocol/muc#user" })
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messageMucSubscribe);
            if (_VERBOSE) console.warn("[XMPP]", ">> Disconnect sent");
            this.closed = true;
        }
    }
    public sendRemoveMessage(messageId: string) {
        const messageRemove = xml(
            "message",
            {
                to: this.roomJid.toString(),
                from: this.jid,
                type: "groupchat",
                id: uuidv4(),
                xmlns: "jabber:client",
            },
            xml("remove", {
                xmlns: "urn:xmpp:message-delete:0",
                origin_id: messageId,
            }),
            xml("body", {}, "")
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(messageRemove);
            if (_VERBOSE) console.warn("[XMPP]", ">> Remove message sent");
        }
    }
    public sendChatState(state: string) {
        const chatState = xml(
            "message",
            {
                type: "groupchat",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: uuidv4(),
            },
            xml(state, {
                xmlns: "http://jabber.org/protocol/chatstates",
            })
        );
        if (!this.closed) {
            this.connection.emitXmlMessage(chatState);
            if (_VERBOSE) console.warn("[XMPP]", ">> Chat state sent");
        }
    }
    public sendMessage(text: string, messageReply?: Message) {
        const idMessage = uuidv4();
        const message = xml(
            "message",
            {
                type: "groupchat",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: idMessage,
            },
            xml("body", {}, text)
        );

        //create message reply
        if (messageReply != undefined) {
            const xmlReplyMessage = xml("reply", {
                to: messageReply.from,
                id: messageReply.id,
                xmlns: "urn:xmpp:reply:0",
                senderName: messageReply.name,
                body: messageReply.body,
            });
            //check if exist files in the reply message
            if (messageReply.files != undefined) {
                xmlReplyMessage.append(fileMessageManager.getXmlFileAttrFrom(messageReply.files));
            }
            //append node xml of reply message
            message.append(xmlReplyMessage);
        }

        //check if exist files into the message
        if (get(filesUploadStore).size > 0) {
            message.append(fileMessageManager.getXmlFileAttr);
        }

        if (get(mentionsUserStore).size > 0) {
            message.append(
                [...get(mentionsUserStore).values()].reduce((xmlValue, user) => {
                    xmlValue.append(
                        xml(
                            "mention",
                            {
                                from: this.jid,
                                to: user.jid,
                                name: user.name,
                                user,
                            } //TODO change it to use an XMPP implementation of mention
                        )
                    );
                    return xmlValue;
                }, xml("mentions"))
            );
        }

        if (!this.closed) {
            this.connection.emitXmlMessage(message);

            this.messageStore.update((messages) => {
                messages.push({
                    name: this.getPlayerName(),
                    jid: this.getMyJID().toString(),
                    body: text,
                    time: new Date(),
                    id: idMessage,
                    delivered: false,
                    error: false,
                    from: this.jid,
                    type: messageReply != undefined ? MessageType.reply : MessageType.message,
                    files: fileMessageManager.files,
                    targetMessageReply:
                        messageReply != undefined
                            ? {
                                  id: messageReply.id,
                                  senderName: messageReply.name,
                                  body: messageReply.body,
                                  files: messageReply.files,
                              }
                            : undefined,
                    mentions: [...get(mentionsUserStore).values()],
                });
                return messages;
            });

            //clear list of file uploaded
            fileMessageManager.reset();
            mentionsUserStore.set(new Set<User>());

            this.manageResendMessage();
        }
    }
    public haveSelected(messageId: string, emojiStr: string) {
        const messages = get(this.messageReactStore).get(messageId);
        if (!messages) return false;

        return messages.reduce((value, message) => {
            if (message.emoji == emojiStr && jid(message.from).getLocal() == jid(this.jid).getLocal()) {
                value = message.operation == ReactAction.add;
            }
            return value;
        }, false);
    }
    public sendReactMessage(emoji: string, messageReact: Message) {
        //define action, delete or not
        let action = ReactAction.add;
        if (this.haveSelected(messageReact.id, emoji)) {
            action = ReactAction.delete;
        }

        const idMessage = uuidv4();
        const newReactMessage = {
            id: idMessage,
            message: messageReact.id,
            from: this.jid,
            emoji,
            operation: action,
        };

        const messageReacted = xml(
            "message",
            {
                type: "groupchat",
                to: jid(this.roomJid.local, this.roomJid.domain).toString(),
                from: this.jid,
                id: idMessage,
            },
            xml("body", {}, emoji),
            xml("reaction", {
                to: messageReact.from,
                from: this.jid,
                id: messageReact.id,
                xmlns: "urn:xmpp:reaction:0",
                reaction: emoji,
                action,
            })
        );

        if (!this.closed) {
            this.connection.emitXmlMessage(messageReacted);

            this.messageReactStore.update((reactMessages) => {
                //create or get list of react message
                let newReactMessages = new Array<ReactMessage>();
                if (reactMessages.has(newReactMessage.message)) {
                    newReactMessages = reactMessages.get(newReactMessage.message) as ReactMessage[];
                }
                //check if already exist
                if (!newReactMessages.find((react) => react.id === newReactMessage.id)) {
                    newReactMessages.push(newReactMessage);
                    reactMessages.set(newReactMessage.message, newReactMessages);
                }
                return reactMessages;
            });

            this.manageResendMessage();
        }
    }

    private manageResendMessage() {
        this.lastMessageSeen = new Date();
        this.countMessagesToSee.set(0);

        if (this.sendTimeOut) {
            clearTimeout(this.sendTimeOut);
        }
        this.sendTimeOut = setTimeout(() => {
            this.messageStore.update((messages) => {
                messages = messages.map((message) => (!message.delivered ? { ...message, error: true } : message));
                return messages;
            });
        }, 10_000);
        if (_VERBOSE) console.warn("[XMPP]", ">> Message sent");
    }

    onMessage(xml: ElementExt): void {
        let handledMessage = false;
        if (_VERBOSE) console.warn("[XMPP]", "<< Stanza received", xml.getName());
        const id = xml.getAttr("id");

        if (id && this.subscriptions.get(id)) {
            handledMessage = true;
        }

        if (xml.getAttr("type") === "error") {
            console.warn("[XMPP]", "<< Error received :", xml.toString());
            if (xml.getChild("error")?.getChildText("text") === "That nickname is already in use by another occupant") {
                connectionManager.connectionOrFail.getXmppClient()?.incrementNickCount();
                this.connect();
                handledMessage = true;
            } else if (xml.getChild("error")?.getChildText("text") === "You have been banned from this room") {
                handledMessage = true;
                this.closed = true;
            }
        }
        // We are receiving the presence from someone
        else if (xml.getName() === "presence") {
            const from = jid(xml.getAttr("from"));
            const type = xml.getAttr("type");

            // If last registered presence received
            if (id === this.presenceId) {
                if (this.closed) {
                    connectionManager.connectionOrFail.getXmppClient()?.removeMuc(this);
                    return;
                } else {
                    this.readyStore.set(true);
                    if (this.type === "live") {
                        this.sendRetrieveLastMessages();
                    }
                }
            }

            const x = xml.getChild("x", "http://jabber.org/protocol/muc#user");

            if (x) {
                if (type === "unavailable") {
                    // FIXME When we can get 2 users that have the same nickname (if they are not getting from the same server) (not safe to check that like this)
                    if (from.resource === this.getPlayerName()) {
                        setTimeout(() => this.connect(), 250);
                        return;
                    }
                }

                const userJID = jid(x.getChild("item")?.getAttr("jid"));
                userJID.setResource("");
                const playUri = xml.getChild("room")?.getAttr("playUri");
                const roomName = xml.getChild("room")?.getAttr("name");
                const uuid = xml.getChild("user")?.getAttr("uuid");
                const color = xml.getChild("user")?.getAttr("color");
                const woka = xml.getChild("user")?.getAttr("woka");
                const isMember = xml.getChild("user")?.getAttr("isMember");
                const visitCardUrl = xml.getChild("user")?.getAttr("visitCardUrl");
                const availabilityStatus = parseInt(xml.getChild("user")?.getAttr("availabilityStatus"));
                //const affiliation = x.getChild("item")?.getAttr("affiliation");
                const role = x.getChild("item")?.getAttr("role");
                if (type === "unavailable") {
                    if (userJID.toString() !== this.getMyJID().toString()) {
                        // If the user is a member and the current user is a member too just disconnect him
                        if (this.getCurrentIsMember(userJID.toString()) && this.getMeIsMember()) {
                            this.updateUser(userJID, null, null, null, null, UserStatus.DISCONNECTED);
                        } else {
                            this.deleteUser(userJID.toString());
                        }
                    }
                } else {
                    if (userJID.toString() === this.getMyJID().toString() && this.getAllSubscriptionsId === "") {
                        this.loadingSubscribers.set(false);
                    }
                    this.updateUser(
                        userJID,
                        from.resource,
                        playUri,
                        roomName,
                        uuid,
                        type === "unavailable" ? UserStatus.DISCONNECTED : UserStatus.AVAILABLE,
                        color,
                        woka,
                        ["admin", "moderator", "owner"].includes(role),
                        isMember === "true",
                        availabilityStatus,
                        null,
                        visitCardUrl
                    );
                }

                handledMessage = true;
            } else if (xml.getChild("c", "http://jabber.org/protocol/caps")) {
                // Noting to do, not used for the moment
            } else {
                if (this.type === "live" && type === "unavailable") {
                    this.readyStore.set(false);
                    this.reset();
                }
                handledMessage = true;
            }
        } else if (xml.getName() === "iq" && xml.getAttr("type") === "result") {
            // Manage registered subscriptions old and new one
            const subscriptions = xml.getChild("subscriptions")?.getChildren("subscription");
            const playUri = xml.getChild("room")?.getAttr("playUri");
            if (subscriptions && this.getAllSubscriptionsId === xml.getAttr("id")) {
                this.loadingSubscribers.set(false);
                subscriptions.forEach((subscription) => {
                    const jid = subscription.getAttr("jid");
                    const nick = subscription.getAttr("nick");
                    this.updateUser(jid, nick, playUri);
                });
                handledMessage = true;
            } else {
                const subscription = xml.getChild("subscribe");
                if (subscription) {
                    const nick = subscription.getAttr("nick");
                    // FIXME When we can get 2 users that have the same nickname (if they are not getting from the same server) (not safe to check that like this)
                    if (nick === this.getPlayerName()) {
                        this.sendPresence();
                        this.sendRequestAllSubscribers();
                    }
                    handledMessage = true;
                }
            }
            // Manage return of MAM response
            const fin = xml.getChild("fin", "urn:xmpp:mam:2");
            if (fin) {
                const complete = fin.getAttr("complete");
                const maxHistoryDate = fin.getAttr("maxHistoryDate");
                const disabled = fin.getAttr("disabled");
                const count = parseInt(
                    fin.getChild("set", "http://jabber.org/protocol/rsm")?.getChildText("count") ?? "0"
                );
                if (disabled && disabled === "true") {
                    this.canLoadOlderMessagesStore.set(false);
                } else {
                    if (maxHistoryDate) {
                        this.maxHistoryDate = maxHistoryDate;
                        if (!get(this.canLoadOlderMessagesStore)) {
                            this.showDisabledLoadOlderMessagesStore.set(true);
                        }
                    } else if (count < 50) {
                        if (complete === "false" || this.maxHistoryDate !== "") {
                            this.showDisabledLoadOlderMessagesStore.set(true);
                        }
                        this.canLoadOlderMessagesStore.set(false);
                    }
                }
                this.loadingStore.set(false);
                handledMessage = true;
            }
        } else if (xml.getName() === "message" && xml.getAttr("type") === "groupchat") {
            if (xml.getChild("subject")) {
                this.description = xml.getChildText("subject") ?? "";
                handledMessage = true;
            } else {
                const from = jid(xml.getAttr("from"));
                const idMessage = xml.getAttr("id");
                const name = from.resource;
                const state = xml.getChildByAttr("xmlns", "http://jabber.org/protocol/chatstates");
                if (!state) {
                    let delay = xml.getChild("delay")?.getAttr("stamp");
                    if (delay) {
                        delay = new Date(delay);
                    } else {
                        delay = new Date();
                    }
                    const body = xml.getChildText("body") ?? "";

                    if (xml.getChild("reaction") != undefined) {
                        //define action, delete or not
                        const newReactMessage = {
                            id: idMessage,
                            message: xml.getChild("reaction")?.getAttr("id"),
                            from: xml.getChild("reaction")?.getAttr("from"),
                            emoji: body,
                            operation: xml.getChild("reaction")?.getAttr("action"),
                        };

                        //update list of message
                        this.messageReactStore.update((reactMessages) => {
                            //create or get list of react message
                            let newReactMessages = new Array<ReactMessage>();
                            if (reactMessages.has(newReactMessage.message)) {
                                newReactMessages = reactMessages.get(newReactMessage.message) as ReactMessage[];
                            }
                            //check if already exist
                            if (!newReactMessages.find((react) => react.id === newReactMessage.id)) {
                                newReactMessages.push(newReactMessage);
                                reactMessages.set(newReactMessage.message, newReactMessages);
                            }
                            return reactMessages;
                        });
                    } else {
                        this.messageStore.update((messages) => {
                            if (messages.find((message) => message.id === idMessage)) {
                                this.countMessagesToSee.set(0);
                                this.lastMessageSeen = new Date();
                                messages = messages.map((message) =>
                                    message.id === idMessage ? { ...message, delivered: true } : message
                                );
                            } //Check if message is deleted
                            else if (xml.getChildByAttr("xmlns", "urn:xmpp:message-delete:0")?.getName() === "remove") {
                                console.log("delete message => ", xml);
                                this.deletedMessagesStore.update((deletedMessages) => [
                                    ...deletedMessages,
                                    xml.getChild("remove")?.getAttr("origin_id"),
                                ]);
                            } else {
                                if (delay > this.lastMessageSeen) {
                                    this.countMessagesToSee.update((last) => last + 1);
                                    if (get(activeThreadStore) !== this || get(availabilityStatusStore) !== 1) {
                                        mediaManager.playNewMessageNotification();
                                        mediaManager.createNotification(name, NotificationType.message, this.name);
                                    }
                                }
                                const presenceStore = mucRoomsStore.getDefaultRoom()?.getPresenceStore();
                                const owner = [...(presenceStore ? get(presenceStore) : new Map<string, User>())].find(
                                    ([, user]) => user.name === name
                                );
                                const message: Message = {
                                    name,
                                    jid: owner ? owner[0] : "",
                                    body,
                                    time: delay,
                                    id: idMessage,
                                    delivered: true,
                                    error: false,
                                    from: from.toString(),
                                    type: xml.getChild("reply") ? MessageType.message : MessageType.reply,
                                };

                                //get reply message
                                if (xml.getChild("reply") != undefined) {
                                    const targetMessageReply = {
                                        ...xml.getChild("reply")?.attrs,
                                    };

                                    //get file of reply message
                                    const files = xml.getChild("reply")?.getChild("files");
                                    if (files != undefined && files instanceof Element) {
                                        targetMessageReply.files = fileMessageManager.getFilesListFromXml(files);
                                    }
                                    message.targetMessageReply = targetMessageReply as ReplyMessage;
                                }

                                //get file of message
                                const files = xml.getChild("files");
                                if (files != undefined && files instanceof Element) {
                                    message.files = fileMessageManager.getFilesListFromXml(files);
                                }

                                //get list of mentions
                                if (xml.getChild("mentions")) {
                                    xml.getChild("mentions")
                                        ?.getChildElements()
                                        .forEach((value) => {
                                            if (message.mentions == undefined) {
                                                message.mentions = [];
                                            }
                                            const uuid = value.getAttr("to");
                                            if (get(this.presenceStore).has(uuid)) {
                                                message.mentions.push(get(this.presenceStore).get(uuid) as User);
                                            } else if (value.getAttr("user")) {
                                                message.mentions.push(value.getAttr("user") as User);
                                            }
                                        });
                                }

                                messages.push(message);
                            }
                            return messages;
                        });
                    }
                    handledMessage = true;
                } else {
                    const { jid } = this.getUserDataByName(name);
                    if (jid !== null && jid) {
                        this.updateUser(
                            jid,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            null,
                            state.getName()
                        );
                    }
                    handledMessage = true;
                }
            }
        } else if (xml.getName() === "message" && xml.getChild("result", "urn:xmpp:mam:2")) {
            const messageXML = xml.getChild("result", "urn:xmpp:mam:2")?.getChild("forwarded")?.getChild("message");
            const from = jid(messageXML?.getAttr("from"));
            const name = from.resource;
            const body = messageXML?.getChildText("body") ?? "";
            const idMessage = messageXML?.getAttr("id");
            const state = messageXML?.getChildByAttr("xmlns", "http://jabber.org/protocol/chatstates");
            let delay = xml
                .getChild("result", "urn:xmpp:mam:2")
                ?.getChild("forwarded")
                ?.getChild("delay", "urn:xmpp:delay")
                ?.getAttr("stamp");
            if (!state && delay) {
                delay = new Date(delay);
                const presenceStore = mucRoomsStore.getDefaultRoom()?.getPresenceStore();
                const owner = [...(presenceStore ? get(presenceStore) : new Map<string, User>())].find(
                    ([, user]) => user.name === name
                );
                const message: Message = {
                    name,
                    jid: owner ? owner[0] : "",
                    body,
                    time: delay,
                    id: idMessage,
                    delivered: true,
                    error: false,
                    from: from.toString(),
                    type: messageXML?.getChild("reply") ? MessageType.message : MessageType.reply,
                };
                //console.warn('MAM message received not state', messageXML?.toString());
                this.messageStore.update((messages) => {
                    messages.unshift(message);
                    return messages.sort((a, b) => a.time.getTime() - b.time.getTime());
                });
            }
            handledMessage = true;
        }

        if (!handledMessage) {
            console.warn("Unhandled message targeted at the room: ", xml);
        }
    }

    private getMeIsAdmin() {
        return get(this.meStore).isAdmin;
    }
    private getMeIsMember() {
        return this.subscribe;
    }
    public getMe() {
        return get(this.presenceStore).get(super.getMyJID().toString());
    }

    private updateUser(
        jid: JID | string,
        nick: string | null = null,
        playUri: string | null = null,
        roomName: string | null = null,
        uuid: string | null = null,
        status: string | null = null,
        color: string | null = null,
        woka: string | null = null,
        isAdmin: boolean | null = null,
        isMember: boolean | null = null,
        availabilityStatus: number | null = null,
        chatState: string | null = null,
        visitCardUrl: string | null = null
    ) {
        let isMe = false;
        const user = get(userStore);
        //MucRoom.encode(user?.email) ?? MucRoom.encode(user?.uuid)) + "@" + EJABBERD_DOMAIN === jid &&
        if (jid.toString() === this.getMyJID()) {
            isMe = true;
            this.meStore.update((me) => {
                me.isAdmin = isAdmin ?? this.getMeIsAdmin();
                return me;
            });
        }
        this.presenceStore.update((list) => {
            list.set(jid.toString(), {
                name: HtmlUtils.convertEmoji(nick ?? this.getCurrentName(jid)),
                playUri: playUri ?? this.getCurrentPlayUri(jid),
                roomName: roomName ?? this.getCurrentRoomName(jid),
                uuid: uuid ?? this.getCurrentUuid(jid),
                status: status ?? this.getCurrentStatus(jid),
                isInSameMap: (playUri ?? this.getCurrentPlayUri(jid)) === user.playUri,
                active: (status ?? this.getCurrentStatus(jid)) === UserStatus.AVAILABLE,
                color: color ?? this.getCurrentColor(jid),
                woka: woka ?? this.getCurrentWoka(jid),
                unreads: false,
                isAdmin: isAdmin ?? this.getCurrentIsAdmin(jid),
                chatState: chatState ?? this.getCurrentChatState(jid),
                isMe,
                jid: jid.toString(),
                isMember: isMember ?? this.getCurrentIsMember(jid),
                availabilityStatus: availabilityStatus ?? this.getCurrentAvailabilityStatus(jid),
                visitCardUrl: visitCardUrl ?? this.getVisitCardUrl(jid),
            });
            numberPresenceUserStore.set(list.size);
            return list;
        });
    }

    private deleteUser(jid: string | JID) {
        this.presenceStore.update((list) => {
            list.delete(jid.toString());
            return list;
        });
    }

    public updateComposingState(state: string) {
        if (state === ChatStates.COMPOSING) {
            if (this.composingTimeOut) {
                clearTimeout(this.composingTimeOut);
            }
            this.sendChatState(ChatStates.COMPOSING);
            this.composingTimeOut = setTimeout(() => {
                this.sendChatState(ChatStates.PAUSED);
                if (this.composingTimeOut) {
                    clearTimeout(this.composingTimeOut);
                }
            }, 5_000);
        } else {
            if (this.composingTimeOut) {
                clearTimeout(this.composingTimeOut);
            }
            this.sendChatState(ChatStates.PAUSED);
        }
    }

    public getUrl(): string {
        return this.roomJid.local + "@" + this.roomJid.domain.toString();
    }

    public deleteMessage(idMessage: string) {
        this.messageStore.update((messages) => {
            return messages.filter((message) => message.id !== idMessage);
        });
        return true;
    }

    public sendBack(idMessage: string) {
        this.messageStore.update((messages) => {
            this.sendMessage(messages.find((message) => message.id === idMessage)?.body ?? "");
            return messages.filter((message) => message.id !== idMessage);
        });
        return true;
    }

    // Get all store
    public getPresenceStore(): UsersStore {
        return this.presenceStore;
    }
    public getTeleportStore(): TeleportStore {
        return this.teleportStore;
    }
    public getMeStore(): MeStore {
        return this.meStore;
    }
    public getLoadingSubscribersStore() {
        return this.loadingSubscribers;
    }
    public getCanLoadOlderMessagesStore() {
        return this.canLoadOlderMessagesStore;
    }
    public getShowDisabledLoadOlderMessagesStore() {
        return this.showDisabledLoadOlderMessagesStore;
    }
    public getRoomReadyStore() {
        return this.readyStore;
    }

    public resetTeleportStore(): void {
        this.teleportStore.set({ state: false, to: null });
    }

    public reset(): void {
        super.reset();
        this.meStore.set({ isAdmin: false });
    }
}
