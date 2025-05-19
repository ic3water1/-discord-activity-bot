if (interaction.customId === 'create_ticket_button') {
    console.log(`[TICKET_BUTTON_DEBUG] 'create_ticket_button' pressed by ${interaction.user.tag}.`);

    if (!guildConfig) {
        console.log(`[TICKET_BUTTON_DEBUG] No guildConfig for guild ${interaction.guildId}. Replying.`);
        await replyEphemeralAutoDelete(interaction, { content: 'Ticket system not configured for this server yet. Please ask an administrator to run /setup.' });
        return;
    }
    console.log(`[TICKET_BUTTON_DEBUG] GuildConfig found.`);

    const member = interaction.member;
    if (guildConfig.shutdownRoleId && member.roles.cache.has(guildConfig.shutdownRoleId)) {
        console.log(`[TICKET_BUTTON_DEBUG] User ${member.user.tag} has shutdown role. Replying.`);
        await replyEphemeralAutoDelete(interaction, { content: `You currently have the "${guildConfig.shutdownRoleName || 'shutdown'}" role and cannot create new tickets.` });
        return;
    }
    console.log(`[TICKET_BUTTON_DEBUG] Shutdown role check passed.`);

    if (openTickets[interaction.guildId]?.[member.id]) {
        const existingTicketChannelId = openTickets[interaction.guildId][member.id];
        const existingTicketChannel = interaction.guild.channels.cache.get(existingTicketChannelId);
        if (existingTicketChannel) {
            console.log(`[TICKET_BUTTON_DEBUG] User ${member.user.tag} already has open ticket ${existingTicketChannel.name}. Replying.`);
            await replyEphemeralAutoDelete(interaction, { content: `You already have an open ticket: ${existingTicketChannel}. Please use your existing ticket or ask for it to be closed.` });
            return;
        }
        console.log(`[TICKET_BUTTON_DEBUG] Stale open ticket record found for user ${member.user.tag}, clearing.`);
        delete openTickets[interaction.guildId][member.id];
    }
    console.log(`[TICKET_BUTTON_DEBUG] No existing open ticket found for user.`);

    const ticketCategory = interaction.guild.channels.cache.get(guildConfig.ticketCategoryId);
    if (!ticketCategory || ticketCategory.type !== ChannelType.GuildCategory) {
        console.log(`[TICKET_BUTTON_DEBUG] Ticket category (ID: ${guildConfig.ticketCategoryId}) not found or not a category. Replying.`);
        await replyEphemeralAutoDelete(interaction, { content: 'Error: The configured ticket category could not be found. Please ask an admin to re-run /setup.' });
        return;
    }
    console.log(`[TICKET_BUTTON_DEBUG] Ticket category "${ticketCategory.name}" found.`);
    
    try {
        console.log(`[TICKET_BUTTON_DEBUG] Attempting to deferReply.`);
        await interaction.deferReply({ ephemeral: true });  // <-- FIXED HERE
        console.log(`[TICKET_BUTTON_DEBUG] Reply deferred successfully.`);

        const userNameForChannel = member.user.username.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'user';
        const ticketChannelName = `ticket-${userNameForChannel}-${member.user.discriminator === '0' ? member.user.id.slice(-4) : member.user.discriminator}`;
        console.log(`[TICKET_BUTTON_DEBUG] Generated ticket channel name: ${ticketChannelName}`);

        const permissionOverwrites = [
            { id: interaction.guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels] },
        ];
        if (guildConfig.adminRoleIds?.length > 0) {
            guildConfig.adminRoleIds.forEach(roleId => {
                if (interaction.guild.roles.cache.has(roleId)) permissionOverwrites.push({ id: roleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.ManageMessages] });
            });
        }
        console.log(`[TICKET_BUTTON_DEBUG] Creating channel in category ${ticketCategory.name}...`);
        const ticketChannel = await ticketCategory.children.create({ name: ticketChannelName, type: ChannelType.GuildText, topic: `Ticket for ${member.user.tag} (ID: ${member.user.id}). Created: ${new Date().toUTCString()}`, permissionOverwrites });
        console.log(`[TICKET_BUTTON_DEBUG] Channel ${ticketChannel.name} created.`);

        const adminMentions = guildConfig.adminRoleIds?.map(id => `<@&${id}>`).join(' ') || 'Administrators';
        await ticketChannel.send({ content: `👋 Hello ${member.toString()}, welcome to your ticket!\n\n🛡️ ${adminMentions} have access to this channel.\n\n🖼️ Please send in your **daily activity screenshot** here or describe any issues you have.` });
        
        if (!openTickets[interaction.guildId]) openTickets[interaction.guildId] = {};
        openTickets[interaction.guildId][member.id] = ticketChannel.id;
        
        await replyEphemeralAutoDelete(interaction, { content: `Your ticket has been created: ${ticketChannel}` }, false, true); // isEdit = true
        console.log(`[TICKET_BUTTON_DEBUG] Ticket ${ticketChannel.name} creation confirmed for ${member.user.tag}.`);
        
        const timeoutId = setTimeout(async () => { /* blank ticket cleanup */ }, 60000);
        blankTicketTimeouts.set(ticketChannel.id, timeoutId);

    } catch (error) {
        console.error(`[TICKET_BUTTON_ERROR] Failed to create ticket for ${member.user.tag}:`, error);
        await replyEphemeralAutoDelete(interaction, { content: 'Error creating ticket. Ensure bot has permissions and setup is correct.' }, false, true);
    }
}

